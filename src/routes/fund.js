import { Router } from 'express';
import { pool } from '../db.js';

// Public and unauthenticated on purpose: the Driver Welfare Fund is meant to
// be transparent. No driver or passenger identities are exposed here.
export function fundRouter() {
  const router = Router();

  router.get('/welfare', async (_req, res) => {
    const { rows: [totals] } = await pool.query(
      `SELECT COALESCE(sum(amount_pkr), 0)::int AS balance_pkr,
              COALESCE(sum(amount_pkr) FILTER (WHERE kind = 'ride_fee'), 0)::int
                AS total_contributed_pkr,
              COALESCE(-sum(amount_pkr) FILTER (WHERE kind = 'welfare_payout'), 0)::int
                AS total_paid_out_pkr
       FROM ledger_entries WHERE account = 'welfare_fund'`,
    );
    const { rows: recent_payouts } = await pool.query(
      `SELECT created_at, (-amount_pkr)::int AS amount_pkr, note
       FROM ledger_entries
       WHERE account = 'welfare_fund' AND kind = 'welfare_payout'
       ORDER BY created_at DESC LIMIT 20`,
    );
    res.json({ ...totals, recent_payouts });
  });

  return router;
}
