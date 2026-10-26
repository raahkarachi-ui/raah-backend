import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { httpError } from '../http.js';
import { requireAdmin } from '../middleware/auth.js';
import { creditFeeBalance } from '../services/ledger.js';

const FuelPriceBody = z.object({
  price_pkr_per_l: z.number().positive().max(2000),
  source: z.string().trim().min(1).max(200),
});
const TopupBody = z.object({
  amount_pkr: z.number().int().positive().max(100_000),
  note: z.string().trim().max(200).optional(),
});
const RejectBody = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(300),
});
const RidesQuery = z.object({
  status: z.enum(['requested', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const DOC_KINDS = ['cnic_front', 'cnic_back', 'license', 'vehicle_registration'];
const PayoutBody = z.object({
  amount_pkr: z.number().int().positive(),
  // Shown publicly on the transparency page, so keep it free of names.
  note: z.string().trim().min(1).max(200),
});

export function adminRouter() {
  const router = Router();
  router.use(requireAdmin);

  // A malformed id is "not found", not a server error.
  router.param('id', (_req, _res, next, id) =>
    z.string().uuid().safeParse(id).success ? next() : next(httpError(404, 'DRIVER_NOT_FOUND')));

  // Cheap check the app calls after login to decide whether to open the
  // Admin Dashboard. The answer comes from the database, never from the app.
  router.get('/me', (req, res) => res.json({ is_admin: true, id: req.user.id }));

  // ---- Driver applications -------------------------------------------------

  router.get('/drivers/pending', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT d.user_id AS id,
              COALESCE(d.name, u.name) AS name,
              COALESCE(d.phone, u.phone) AS phone,
              d.cnic, d.license_number,
              d.vehicle_reg_no, d.vehicle_type, d.vehicle_category, d.plate_no, d.applied_at,
              COALESCE(
                (SELECT array_agg(kind) FROM driver_documents WHERE driver_id = d.user_id),
                '{}') AS doc_kinds
         FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE d.status = 'pending'
        ORDER BY d.applied_at ASC`,
    );
    res.json({
      drivers: rows.map(({ doc_kinds, ...d }) => ({
        ...d,
        // Photos are fetched one by one (they are large); the app sends its
        // admin token with each request.
        documents: Object.fromEntries(
          DOC_KINDS.filter((k) => doc_kinds.includes(k)).map((k) => [
            k,
            `/api/v1/admin/drivers/${d.id}/documents/${k}`,
          ]),
        ),
      })),
    });
  });

  router.get('/drivers/:id/documents/:kind', async (req, res) => {
    if (!DOC_KINDS.includes(req.params.kind)) throw httpError(404, 'DOCUMENT_NOT_FOUND');
    const { rows: [doc] } = await pool.query(
      'SELECT mime_type, data FROM driver_documents WHERE driver_id = $1 AND kind = $2',
      [req.params.id, req.params.kind],
    );
    if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');
    res.set({
      'Content-Type': doc.mime_type,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(doc.data);
  });

  // Approving also grants the 'driver' role, atomically.
  router.post('/drivers/:id/approve', async (req, res) => {
    const d = await withTransaction(async (db) => {
      const { rows: [d] } = await db.query(
        `UPDATE drivers
            SET status = 'approved', rejection_reason = NULL,
                reviewed_at = now(), reviewed_by = $2
          WHERE user_id = $1 AND status = 'pending'
          RETURNING user_id AS id, status`,
        [req.params.id, req.user.id],
      );
      if (!d) return null;
      await db.query("UPDATE users SET role = 'driver' WHERE id = $1 AND role = 'passenger'", [d.id]);
      return d;
    });
    if (!d) await explainNoPending(req.params.id);
    res.json({ driver: d });
  });

  router.post('/drivers/:id/reject', async (req, res) => {
    const { reason } = RejectBody.parse(req.body);
    const { rows: [d] } = await pool.query(
      `UPDATE drivers
          SET status = 'rejected', rejection_reason = $3,
              reviewed_at = now(), reviewed_by = $2
        WHERE user_id = $1 AND status = 'pending'
        RETURNING user_id AS id, status, rejection_reason`,
      [req.params.id, req.user.id, reason],
    );
    if (!d) await explainNoPending(req.params.id);
    res.json({ driver: d });
  });

  async function explainNoPending(id) {
    const { rows: [d] } = await pool.query(
      'SELECT status FROM drivers WHERE user_id = $1', [id]);
    if (!d) throw httpError(404, 'DRIVER_NOT_FOUND');
    throw httpError(409, 'INVALID_STATE', `This application is already ${d.status}.`);
  }

  // ---- Ride history ---------------------------------------------------------

  router.get('/rides', async (req, res) => {
    const { status, limit, offset } = RidesQuery.parse(req.query);
    const where = status ? 'WHERE r.status = $1' : '';
    const args = status ? [status] : [];
    const { rows: [{ total }] } = await pool.query(
      `SELECT count(*)::int AS total FROM rides r ${where}`, args);
    const { rows } = await pool.query(
      `SELECT r.id, r.status, r.payment_method, r.payment_status, r.vehicle_category,
              r.pickup_address, r.dropoff_address, r.distance_km,
              r.total_fare_pkr, r.platform_fee_pkr, r.driver_earnings_pkr,
              r.created_at, r.completed_at,
              r.passenger_id, p.name AS passenger_name, p.phone AS passenger_phone,
              r.driver_id,    d.name AS driver_name,    d.phone AS driver_phone
         FROM rides r
         JOIN users p ON p.id = r.passenger_id
         LEFT JOIN users d ON d.id = r.driver_id
         ${where}
        ORDER BY r.created_at DESC
        LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    res.json({
      total,
      rides: rows.map((r) => ({
        id: r.id,
        status: r.status,
        payment_method: r.payment_method,
        payment_status: r.payment_status,
        vehicle_category: r.vehicle_category,
        pickup_address: r.pickup_address,
        dropoff_address: r.dropoff_address,
        distance_km: Number(r.distance_km ?? 0),
        total_fare_pkr: r.total_fare_pkr,
        platform_fee_pkr: r.platform_fee_pkr,
        driver_earnings_pkr: r.driver_earnings_pkr,
        created_at: r.created_at,
        completed_at: r.completed_at,
        passenger: { id: r.passenger_id, name: r.passenger_name, phone: r.passenger_phone },
        driver: r.driver_id
          ? { id: r.driver_id, name: r.driver_name, phone: r.driver_phone }
          : null,
      })),
    });
  });

  // ---- Fuel price, fee top-ups, welfare fund -------------------------------

  // Current petrol price (newest row), for the Admin "Fuel Price" tab.
  router.get('/fuel-price', async (_req, res) => {
    const { rows: [p] } = await pool.query(
      `SELECT price_pkr_per_l, source, effective_from
         FROM fuel_prices ORDER BY effective_from DESC, id DESC LIMIT 1`,
    );
    res.json({
      current: p
        ? {
            price_pkr_per_l: Number(p.price_pkr_per_l),
            source: p.source,
            effective_from: p.effective_from,
          }
        : null,
    });
  });

  // When the official petrol price changes, set it here. New quotes use it
  // immediately; in-flight quotes are refused at booking with PRICE_CHANGED so
  // nobody is charged a fare they did not see.
  router.put('/fuel-price', async (req, res) => {
    const body = FuelPriceBody.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO fuel_prices (price_pkr_per_l, set_by, source)
       VALUES ($1, $2, $3) RETURNING id, price_pkr_per_l, effective_from`,
      [body.price_pkr_per_l, req.user.id, body.source],
    );
    res.status(201).json(rows[0]);
  });

  // Manual credit until Easypaisa/JazzCash top-up webhooks are wired in.
  router.post('/drivers/:id/fee-topup', async (req, res) => {
    const { amount_pkr, note } = TopupBody.parse(req.body);
    await withTransaction(async (db) => {
      const { rowCount } = await db.query('SELECT 1 FROM drivers WHERE user_id = $1', [req.params.id]);
      if (!rowCount) throw httpError(404, 'DRIVER_NOT_FOUND');
      await creditFeeBalance(db, req.params.id, amount_pkr, note ?? 'manual top-up');
    });
    res.status(201).json({ credited_pkr: amount_pkr });
  });

  // Records money leaving the Welfare Fund (challan, accident, etc.).
  router.post('/welfare/payout', async (req, res) => {
    const { amount_pkr, note } = PayoutBody.parse(req.body);
    await withTransaction(async (db) => {
      // Serialise payouts so two requests cannot overdraw the fund.
      await db.query('LOCK TABLE ledger_entries IN SHARE ROW EXCLUSIVE MODE');
      const { rows: [{ balance }] } = await db.query(
        `SELECT COALESCE(sum(amount_pkr), 0)::int AS balance
         FROM ledger_entries WHERE account = 'welfare_fund'`,
      );
      if (balance < amount_pkr) throw httpError(409, 'INSUFFICIENT_FUND');
      await db.query(
        `INSERT INTO ledger_entries (account, kind, amount_pkr, note)
         VALUES ('welfare_fund', 'welfare_payout', $1, $2)`,
        [-amount_pkr, note],
      );
    });
    res.status(201).json({ paid_out_pkr: amount_pkr });
  });

  return router;
}
