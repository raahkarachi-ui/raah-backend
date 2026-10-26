// DEVELOPMENT ONLY helpers that say WHO is calling, for the memory-mode
// driver and admin routes.
import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { httpError } from '../http.js';

/**
 * Requires a valid login token (the one issued by /auth/verify-otp) and sets
 * req.user = { id, phone }. Unlike the passenger routes, which accept any
 * token in memory mode, driver routes need to know the real user.
 */
export function requireUser(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(httpError(401, 'UNAUTHENTICATED'));

  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') throw new Error('token has no subject');
    req.user = {
      id: payload.sub,
      phone: typeof payload.phone === 'string' ? payload.phone : null,
    };
    next();
  } catch {
    next(httpError(401, 'INVALID_TOKEN'));
  }
}

/** The admin key. Set ADMIN_KEY in the environment; the default is dev-only. */
export function adminKey() {
  return process.env.ADMIN_KEY || 'dev-admin-key';
}

/**
 * Guards the admin routes. Send the key as the `x-admin-key` header. For
 * convenience while developing, `?admin_key=...` also works, so you can open a
 * document photo straight in the browser. (A key in a URL leaks into logs and
 * history: real admin access needs proper admin accounts.)
 */
export function requireAdminKey(req, _res, next) {
  const supplied =
    req.get('x-admin-key') ??
    (typeof req.query.admin_key === 'string' ? req.query.admin_key : '');

  // Hash both sides so the comparison is constant-time and length-safe.
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(adminKey()).digest();
  if (!timingSafeEqual(a, b)) return next(httpError(401, 'INVALID_ADMIN_KEY'));
  next();
}