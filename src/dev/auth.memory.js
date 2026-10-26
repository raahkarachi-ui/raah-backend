// DEVELOPMENT ONLY. Mock phone-OTP login: no SMS is sent, the OTP is always
// 1234 and is returned in the response so the app can show it. Users and OTPs
// live in memory and vanish when the server stops.
//
// Replace with a real SMS provider and a users table before launch.
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { httpError } from '../http.js';

const MOCK_OTP = '1234';
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const SendBody = z.object({ phone: z.string() });
const VerifyBody = z.object({ phone: z.string(), otp: z.string() });

/**
 * Accepts 03001234567, 3001234567, +923001234567, 923001234567 or 0092...,
 * with spaces or dashes, and returns +923001234567. Null if it is not a
 * Pakistani mobile number.
 */
export function normalizePkPhone(raw) {
  const compact = String(raw ?? '').replace(/[\s\-()]/g, '');
  const match = compact.match(/^(?:\+92|0092|92|0)?(3\d{9})$/);
  return match ? `+92${match[1]}` : null;
}

export function authMemoryRouter() {
  const router = Router();
  const pendingOtps = new Map(); // phone -> { code, expiresAt, attempts }
  const users = new Map(); // phone -> user id (stable across logins)

  router.post('/send-otp', (req, res) => {
    const { phone: rawPhone } = SendBody.parse(req.body ?? {});
    const phone = normalizePkPhone(rawPhone);
    if (!phone) {
      throw httpError(400, 'INVALID_PHONE', 'Enter a valid Pakistani mobile number');
    }

    pendingOtps.set(phone, {
      code: MOCK_OTP,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
    });

    res.json({
      phone,
      expires_in_seconds: OTP_TTL_MS / 1000,
      // Dev only: a real server would never return the code.
      dev_otp: MOCK_OTP,
    });
  });

  router.post('/verify-otp', (req, res) => {
    const body = VerifyBody.parse(req.body ?? {});
    const phone = normalizePkPhone(body.phone);
    if (!phone) throw httpError(400, 'INVALID_PHONE', 'Enter a valid Pakistani mobile number');

    const pending = pendingOtps.get(phone);
    if (!pending) throw httpError(400, 'OTP_NOT_REQUESTED', 'Request an OTP first');
    if (pending.expiresAt < Date.now()) {
      pendingOtps.delete(phone);
      throw httpError(400, 'OTP_EXPIRED', 'That OTP has expired. Request a new one.');
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      throw httpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong tries. Request a new OTP.');
    }
    if (body.otp.trim() !== pending.code) {
      pending.attempts += 1;
      throw httpError(400, 'INVALID_OTP', 'That OTP is not correct');
    }

    pendingOtps.delete(phone); // one use only

    if (!users.has(phone)) users.set(phone, randomUUID());
    const userId = users.get(phone);

    // Same shape the real API expects: { sub: <user id>, role }, plus the
    // verified phone so driver registration can check it matches.
    const token = jwt.sign({ sub: userId, role: 'passenger', phone }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '30d',
    });

    res.json({ token, user: { id: userId, phone, role: 'passenger' } });
  });

  return router;
}