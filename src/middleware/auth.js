// The OTP login router (the file you first pasted as "middleware/auth.js").
// If your project names it differently, copy this content into that file.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db.js';
import { config } from '../config.js';
import { httpError } from '../http.js';
import { normalizePkPhone } from '../phone.js';

const MOCK_OTP = '1234';
const OTP_TTL_MS = 5 * 60 * 1000;

const SendBody = z.object({ phone: z.string() });
const VerifyBody = z.object({ phone: z.string(), otp: z.string() });

export function authRouter() {
  const router = Router();

  router.post('/send-otp', async (req, res) => {
    const { phone: raw } = SendBody.parse(req.body ?? {});
    const phone = normalizePkPhone(raw);
    if (!phone) {
      throw httpError(400, 'INVALID_PHONE', 'Enter a valid mobile number, e.g. 0300 1234567.');
    }
    res.json({ phone, expires_in_seconds: OTP_TTL_MS / 1000, dev_otp: MOCK_OTP });
  });

  router.post('/verify-otp', async (req, res) => {
    const { phone: raw, otp } = VerifyBody.parse(req.body ?? {});
    const phone = normalizePkPhone(raw);
    if (!phone) throw httpError(400, 'INVALID_PHONE', 'Enter a valid mobile number.');
    if (otp !== MOCK_OTP) {
      throw httpError(400, 'INVALID_OTP', 'That OTP is not correct');
    }

    // Find or create the user
    let result = await pool.query('SELECT id, role, name, phone FROM users WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      result = await pool.query(
        "INSERT INTO users (role, name, phone) VALUES ('passenger', 'Passenger', $1) RETURNING id, role, name, phone",
        [phone],
      );
    }
    const user = result.rows[0];

    const token = jwt.sign(
      { sub: user.id, role: user.role, phone: user.phone },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '30d' },
    );

    res.json({ token, user });
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────────
// JWT-authenticated route guards.
//
// These decode the bearer token themselves (there is no upstream global
// verify middleware in server.js), then enforce role requirements.
//
// Used by:
//   admin.js   → requireAdmin
//   rides.js   → requireRole(...), requireDriver
// ─────────────────────────────────────────────────────────────────────

/** Decodes the bearer token and sets req.user = { id, phone, role }. */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(httpError(401, 'UNAUTHENTICATED'));

  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') throw new Error('token has no subject');
    req.user = {
      id: payload.sub,
      phone: typeof payload.phone === 'string' ? payload.phone : null,
      role: typeof payload.role === 'string' ? payload.role : null,
    };
    next();
  } catch {
    next(httpError(401, 'INVALID_TOKEN'));
  }
}

/**
 * Factory: returns middleware that requires one of the given roles.
 * Runs requireAuth first, so the route doesn't need to wire it separately.
 */
export function requireRole(...roles) {
  return function (req, res, next) {
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if (!req.user?.role || !roles.includes(req.user.role)) {
        return next(httpError(403, 'FORBIDDEN'));
      }
      next();
    });
  };
}

/** Admin-only middleware. */
export const requireAdmin = requireRole('admin');

/** Driver-only middleware. */
export const requireDriver = requireRole('driver');
/** Alias kept for backward-compat: routes/drivers.js imports this as `requireUser`. */
export const requireUser = requireAuth;
