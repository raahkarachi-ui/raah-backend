import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db.js';
import { config } from '../config.js';
import { httpError } from '../http.js';

const MOCK_OTP = '1234';
const OTP_TTL_MS = 5 * 60 * 1000;

const SendBody = z.object({ phone: z.string() });
const VerifyBody = z.object({ phone: z.string(), otp: z.string() });

export function authRouter() {
  const router = Router();

  router.post('/send-otp', async (req, res) => {
    const { phone } = SendBody.parse(req.body ?? {});
    res.json({ phone, expires_in_seconds: OTP_TTL_MS / 1000, dev_otp: MOCK_OTP });
  });

  router.post('/verify-otp', async (req, res) => {
    const { phone, otp } = VerifyBody.parse(req.body ?? {});
    if (otp !== MOCK_OTP) {
      throw httpError(400, 'INVALID_OTP', 'That OTP is not correct');
    }

    // Find or create the user
    let result = await pool.query('SELECT id, role, name, phone FROM users WHERE phone = $1', [phone]);
    let user;
    if (result.rows.length === 0) {
      result = await pool.query(
        "INSERT INTO users (role, name, phone) VALUES ('passenger', 'Passenger', $1) RETURNING id, role, name, phone",
        [phone],
      );
    }
    user = result.rows[0];

    const token = jwt.sign(
      { sub: user.id, role: user.role, phone: user.phone },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '30d' },
    );

    res.json({ token, user });
  });

  return router;
}