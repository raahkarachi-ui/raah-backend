import { Router, json } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { httpError } from '../http.js';
import { requireUser } from '../middleware/auth.js';
import { normalizePkPhone } from '../phone.js';
import { CATEGORY_IDS, categoryById } from '../services/vehicleCategories.js';

const Location = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const DateQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const DOC_KINDS = ['cnic_front', 'cnic_back', 'license', 'vehicle_registration'];
const MAX_DOC_BYTES = 3 * 1024 * 1024;

const RegisterBody = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string(),
  cnic: z.string().regex(/^\d{5}-\d{7}-\d$/, 'CNIC must look like 42101-1234567-1'),
  license_number: z.string().trim().min(3).max(40),
  vehicle_reg_no: z.string().trim().min(3).max(20),
  vehicle_category: z.enum(CATEGORY_IDS),
  documents: z.record(z.string()),
});

/** Only JPEG and PNG are accepted; the type comes from the bytes, not the client. */
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length > 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  return null;
}

/** The shape DriverProfile.fromJson in the app expects. */
function profileJson(d) {
  if (!d) return { status: 'not_registered', rejection_reason: null, driver: null };
  return {
    status: d.status,
    rejection_reason: d.rejection_reason ?? null,
    driver: {
      name: d.name,
      phone: d.phone,
      cnic: d.cnic,
      license_number: d.license_number,
      vehicle_reg_no: d.vehicle_reg_no,
      vehicle_category: d.vehicle_category,
    },
  };
}

/** Approved drivers only, checked in the database (not the JWT, which can be stale). */
async function requireApprovedDriver(req, _res, next) {
  try {
    const { rows: [d] } = await pool.query('SELECT status FROM drivers WHERE user_id = $1', [req.user.id]);
    if (!d) throw httpError(403, 'NOT_A_DRIVER');
    if (d.status !== 'approved') throw httpError(403, 'DRIVER_NOT_APPROVED');
    next();
  } catch (err) {
    next(err);
  }
}

export function driversRouter({ presence }) {
  const router = Router();

  // ---- Registration & status (login required, not approval) ---------------

  router.get('/me/status', requireUser, async (req, res) => {
    const { rows: [d] } = await pool.query('SELECT * FROM drivers WHERE user_id = $1', [req.user.id]);
    res.json(profileJson(d));
  });

  // 15mb: four photos as base64.
  router.post('/register', requireUser, json({ limit: '15mb' }), async (req, res) => {
    const data = RegisterBody.parse(req.body ?? {});

    const phone = normalizePkPhone(data.phone);
    const { rows: [user] } = await pool.query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
    if (!phone || phone !== user?.phone) {
      throw httpError(400, 'PHONE_MISMATCH', 'Use the same mobile number you logged in with.');
    }

    const docs = {};
    for (const kind of DOC_KINDS) {
      const b64 = data.documents[kind];
      if (!b64) throw httpError(400, 'INVALID_DOCUMENT', `Missing photo: ${kind}.`);
      const bytes = Buffer.from(b64, 'base64');
      const mime = sniffImage(bytes);
      if (!mime || bytes.length > MAX_DOC_BYTES) {
        throw httpError(400, 'INVALID_DOCUMENT', `${kind} must be a JPEG or PNG under 3 MB.`);
      }
      docs[kind] = { bytes, mime };
    }

    const cat = categoryById(data.vehicle_category);

    const row = await withTransaction(async (db) => {
      const { rows: [existing] } = await db.query(
        'SELECT status FROM drivers WHERE user_id = $1 FOR UPDATE', [req.user.id]);
      // New drivers, or a driver whose application was rejected, may apply.
      if (existing && existing.status !== 'rejected') {
        throw httpError(409, 'ALREADY_REGISTERED', 'You have already registered as a driver.');
      }
      const { rows: [dup] } = await db.query(
        'SELECT 1 FROM drivers WHERE cnic = $1 AND user_id <> $2', [data.cnic, req.user.id]);
      if (dup) throw httpError(409, 'CNIC_ALREADY_REGISTERED', 'This CNIC is already registered.');

      const args = [
        req.user.id, data.name, phone, data.cnic, data.license_number,
        data.vehicle_reg_no, cat.vehicleType, cat.id,
      ];
      const { rows: [d] } = existing
        ? await db.query(
            `UPDATE drivers
                SET name = $2, phone = $3, cnic = $4, license_number = $5,
                    vehicle_reg_no = $6, plate_no = $6,
                    vehicle_type = $7, vehicle_category = $8,
                    status = 'pending', rejection_reason = NULL,
                    reviewed_at = NULL, reviewed_by = NULL, applied_at = now()
              WHERE user_id = $1 RETURNING *`, args)
        : await db.query(
            `INSERT INTO drivers (user_id, name, phone, cnic, license_number,
                                  vehicle_reg_no, plate_no, vehicle_type, vehicle_category, status)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, 'pending') RETURNING *`, args);

      await db.query('DELETE FROM driver_documents WHERE driver_id = $1', [req.user.id]);
      for (const [kind, { bytes, mime }] of Object.entries(docs)) {
        await db.query(
          'INSERT INTO driver_documents (driver_id, kind, mime_type, data) VALUES ($1, $2, $3, $4)',
          [req.user.id, kind, mime, bytes]);
      }
      return d;
    });
    res.status(201).json(profileJson(row));
  });

  // ---- Everything below needs an approved driver ---------------------------
  router.use(requireUser, requireApprovedDriver);

  router.get('/me', async (req, res) => {
    const { rows: [d] } = await pool.query(
      `SELECT u.name, d.vehicle_type, d.vehicle_category, d.plate_no, d.fee_balance_pkr
       FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1`,
      [req.user.id],
    );
    if (!d) throw httpError(404, 'DRIVER_NOT_FOUND');
    res.json({ ...d, platform_fee_pkr: config.fare.platformFeePkr });
  });

  router.post('/online', async (req, res) => {
    const { rows: [d] } = await pool.query(
      'SELECT fee_balance_pkr FROM drivers WHERE user_id = $1',
      [req.user.id],
    );
    if (!d) throw httpError(404, 'DRIVER_NOT_FOUND');
    if (d.fee_balance_pkr < config.fare.platformFeePkr) {
      throw httpError(402, 'INSUFFICIENT_FEE_BALANCE', 'Top up your fee balance to go online.');
    }
    const { rows: active } = await pool.query(
      `SELECT 1 FROM rides WHERE driver_id = $1 AND status IN ('accepted','arrived','in_progress')`,
      [req.user.id],
    );
    if (active.length === 0) await presence.setAvailable(req.user.id, true);
    res.json({ online: true });
  });

  router.post('/offline', async (req, res) => {
    await presence.setAvailable(req.user.id, false);
    res.json({ online: false });
  });

  router.post('/location', async (req, res) => {
    await presence.updateLocation(req.user.id, Location.parse(req.body));
    res.status(204).end();
  });

  router.get('/me/offer', async (req, res) => {
    res.json({ offer: await presence.getOffer(req.user.id) });
  });

  router.get('/me/earnings/daily', async (req, res) => {
    const { date } = DateQuery.parse(req.query);
    const day = `COALESCE($2::date, (now() AT TIME ZONE 'Asia/Karachi')::date)`;
    const where = `driver_id = $1 AND status = 'completed'
                   AND (completed_at AT TIME ZONE 'Asia/Karachi')::date = ${day}`;

    const { rows: [totals] } = await pool.query(
      `SELECT count(*)::int                                     AS rides,
              COALESCE(sum(total_fare_pkr), 0)::int             AS gross_fares_pkr,
              COALESCE(sum(platform_fee_pkr), 0)::int           AS platform_fees_pkr,
              COALESCE(sum(driver_earnings_pkr), 0)::int        AS net_earnings_pkr,
              COALESCE(sum(total_fare_pkr) FILTER (WHERE payment_method = 'cash'), 0)::int
                                                                AS cash_fares_pkr
       FROM rides WHERE ${where}`,
      [req.user.id, date ?? null],
    );
    const { rows: rides } = await pool.query(
      `SELECT id, completed_at, pickup_address, dropoff_address, payment_method,
              total_fare_pkr, platform_fee_pkr, driver_earnings_pkr
       FROM rides WHERE ${where} ORDER BY completed_at DESC`,
      [req.user.id, date ?? null],
    );
    res.json({ totals, rides });
  });

  return router;
}
