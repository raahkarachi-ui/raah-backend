// DEVELOPMENT ONLY. Driver registration and manual verification, in memory.
// Applications and document photos vanish when the server stops.
//
//   Driver:  POST /api/v1/drivers/register      GET /api/v1/drivers/me
//   Admin:   GET  /api/v1/admin/drivers/pending
//            GET  /api/v1/admin/drivers/:id/documents/:type
//            POST /api/v1/admin/drivers/:id/approve
//            POST /api/v1/admin/drivers/:id/reject     { "reason": "..." }
//
// A driver's id is their login user id (the token's `sub`).
import express, { Router } from 'express';
import { z } from 'zod';
import { httpError } from '../http.js';
import { normalizePkPhone } from './auth.memory.js';
import { requireAdminKey, requireUser } from './identity.js';

export const DOCUMENT_LABELS = {
  cnic_front: 'CNIC (front)',
  cnic_back: 'CNIC (back)',
  license: 'Driving license',
  vehicle_registration: 'Vehicle registration',
};
const DOCUMENT_TYPES = Object.keys(DOCUMENT_LABELS);
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Shared by the driver routes, admin routes and the rides approval gate. */
export function createDriverStore() {
  const drivers = new Map(); // user id -> application record
  return {
    drivers,
    isApproved: (userId) => drivers.get(userId)?.status === 'approved',
  };
}

// ---- Validation ------------------------------------------------------------

/** 13 digits -> 42101-1234567-1, or null. */
export function normalizeCnic(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length !== 13) return null;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

function normalizeLicense(raw) {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  return /^[A-Z0-9\-/ ]{4,30}$/.test(value) ? value : null;
}

function normalizeVehicleReg(raw) {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  return /^[A-Z0-9\- ]{3,15}$/.test(value) ? value : null;
}

/** Looks at the first bytes, so a renamed .txt or .exe is not accepted. */
function sniffImageType(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length > 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function decodeDocument(type, value) {
  const label = DOCUMENT_LABELS[type];
  const base64 = value.replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw httpError(400, 'INVALID_DOCUMENT', `${label} is not valid image data`);
  }
  const data = Buffer.from(base64, 'base64');
  if (data.length > MAX_DOCUMENT_BYTES) {
    throw httpError(400, 'DOCUMENT_TOO_LARGE', `${label} is larger than 2 MB`);
  }
  const contentType = sniffImageType(data);
  if (!contentType) {
    throw httpError(400, 'INVALID_DOCUMENT', `${label} must be a JPEG, PNG or WebP photo`);
  }
  return { contentType, data };
}

// One document is at most 2 MB, which is about 2.8 million base64 characters.
const DocumentString = z.string().min(20).max(2_900_000);
const RegisterBody = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string(),
  cnic: z.string(),
  license_number: z.string(),
  vehicle_reg_no: z.string(),
  documents: z.object({
    cnic_front: DocumentString,
    cnic_back: DocumentString,
    license: DocumentString,
    vehicle_registration: DocumentString,
  }),
});
const RejectBody = z.object({ reason: z.string().trim().min(3).max(300) });

// ---- Views (never include the document bytes) --------------------------------

function driverView(record) {
  return {
    id: record.id,
    name: record.name,
    phone: record.phone,
    cnic: record.cnic,
    license_number: record.license_number,
    vehicle_reg_no: record.vehicle_reg_no,
    submitted_at: record.submitted_at,
    reviewed_at: record.reviewed_at,
  };
}

function statusView(record) {
  if (!record) return { status: 'not_registered', rejection_reason: null, driver: null };
  return {
    status: record.status,
    rejection_reason: record.rejection_reason,
    driver: driverView(record),
  };
}

// ---- Driver routes ----------------------------------------------------------

export function driversMemoryRouter(store) {
  const router = Router();
  const { drivers } = store;

  router.get('/me', requireUser, (req, res) => {
    res.json(statusView(drivers.get(req.user.id)));
  });

  // The body carries four photos, so it gets its own larger limit. Auth runs
  // first, so anonymous callers cannot make the server parse a big body.
  router.post('/register', requireUser, express.json({ limit: '12mb' }), (req, res) => {
    const body = RegisterBody.parse(req.body ?? {});

    const phone = normalizePkPhone(body.phone);
    if (!phone) throw httpError(400, 'INVALID_PHONE', 'Enter a valid Pakistani mobile number');
    if (req.user.phone && req.user.phone !== phone) {
      throw httpError(400, 'PHONE_MISMATCH', 'Use the same mobile number you logged in with');
    }
    const cnic = normalizeCnic(body.cnic);
    if (!cnic) throw httpError(400, 'INVALID_CNIC', 'Enter a valid 13-digit CNIC');
    const licenseNumber = normalizeLicense(body.license_number);
    if (!licenseNumber) throw httpError(400, 'INVALID_LICENSE', 'Enter a valid license number');
    const vehicleRegNo = normalizeVehicleReg(body.vehicle_reg_no);
    if (!vehicleRegNo) throw httpError(400, 'INVALID_VEHICLE', 'Enter a valid vehicle registration number');

    // Pending and approved applications cannot be replaced. A rejected one can:
    // that is the "Try Again" path.
    const existing = drivers.get(req.user.id);
    if (existing && existing.status !== 'rejected') {
      throw httpError(409, 'ALREADY_REGISTERED', 'You have already applied');
    }
    // One real identity, one account.
    for (const other of drivers.values()) {
      if (other.id === req.user.id || other.status === 'rejected') continue;
      if (other.cnic === cnic) throw httpError(409, 'CNIC_ALREADY_REGISTERED', 'This CNIC is already registered');
      if (other.license_number === licenseNumber) throw httpError(409, 'LICENSE_ALREADY_REGISTERED', 'This license is already registered');
      if (other.vehicle_reg_no === vehicleRegNo) throw httpError(409, 'VEHICLE_ALREADY_REGISTERED', 'This vehicle is already registered');
    }

    const documents = {};
    for (const type of DOCUMENT_TYPES) {
      documents[type] = decodeDocument(type, body.documents[type]);
    }

    const record = {
      id: req.user.id,
      name: body.name,
      phone,
      cnic,
      license_number: licenseNumber,
      vehicle_reg_no: vehicleRegNo,
      status: 'pending',
      rejection_reason: null,
      documents,
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
    };
    drivers.set(record.id, record);

    res.status(201).json(statusView(record));
  });

  return router;
}

// ---- Admin routes -----------------------------------------------------------

export function adminMemoryRouter(store) {
  const router = Router();
  const { drivers } = store;
  router.use(requireAdminKey);

  router.get('/drivers/pending', (_req, res) => {
    const pending = [...drivers.values()]
      .filter((d) => d.status === 'pending')
      .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))
      .map((d) => ({
        ...driverView(d),
        status: d.status,
        documents: Object.fromEntries(
          DOCUMENT_TYPES.map((t) => [t, `/api/v1/admin/drivers/${d.id}/documents/${t}`]),
        ),
      }));
    res.json({ drivers: pending });
  });

  router.get('/drivers/:id/documents/:type', (req, res) => {
    const record = drivers.get(req.params.id);
    const doc = record?.documents[req.params.type];
    if (!doc) throw httpError(404, 'DOCUMENT_NOT_FOUND');

    res
      .set({
        'Content-Type': doc.contentType, // set from the file's real bytes
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(doc.data);
  });

  function review(req, res, next, apply) {
    const record = drivers.get(req.params.id);
    if (!record) throw httpError(404, 'DRIVER_NOT_FOUND');
    if (record.status !== 'pending') {
      throw httpError(409, 'INVALID_STATE', `This application is already ${record.status}`);
    }
    apply(record);
    record.reviewed_at = new Date().toISOString();
    res.json(statusView(record));
  }

  router.post('/drivers/:id/approve', (req, res, next) =>
    review(req, res, next, (record) => {
      record.status = 'approved';
      record.rejection_reason = null;
    }),
  );

  router.post('/drivers/:id/reject', (req, res, next) => {
    const { reason } = RejectBody.parse(req.body ?? {});
    review(req, res, next, (record) => {
      record.status = 'rejected';
      record.rejection_reason = reason;
    });
  });

  return router;
}