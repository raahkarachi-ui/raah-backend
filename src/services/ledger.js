import { config } from '../config.js';
import { splitPlatformFee } from './fare.js';

/**
 * Settles the flat platform fee for a completed ride, inside the caller's
 * transaction. The fee is drawn from the driver's PREPAID fee balance, so the
 * platform never holds or collects the driver's fare (cash goes straight to
 * the driver). The fee is split: welfare share to the Driver Welfare Fund,
 * the remainder to operations.
 */
export async function settleRideFee(db, ride) {
  const fee = ride.platform_fee_pkr;
  const { welfarePkr, operationsPkr } = splitPlatformFee(
    fee,
    config.fund.welfareShareBps,
  );

  const entries = [
    { account: 'driver_fee_balance', driverId: ride.driver_id, amount: -fee },
    { account: 'welfare_fund', driverId: null, amount: welfarePkr },
    { account: 'operations', driverId: null, amount: operationsPkr },
  ].filter((e) => e.amount !== 0);

  // Invariant: a ride's fee entries net to zero.
  if (entries.reduce((sum, e) => sum + e.amount, 0) !== 0) {
    throw new Error(`Ledger imbalance for ride ${ride.id}`);
  }

  // The CHECK (fee_balance_pkr >= 0) on drivers rejects an overdraw.
  await db.query(
    'UPDATE drivers SET fee_balance_pkr = fee_balance_pkr - $1 WHERE user_id = $2',
    [fee, ride.driver_id],
  );

  for (const e of entries) {
    await db.query(
      `INSERT INTO ledger_entries (ride_id, driver_id, account, kind, amount_pkr)
       VALUES ($1, $2, $3, 'ride_fee', $4)`,
      [ride.id, e.driverId, e.account, e.amount],
    );
  }
}

/** Credits a driver's prepaid fee balance (money in from a wallet top-up). */
export async function creditFeeBalance(db, driverId, amountPkr, note) {
  await db.query(
    'UPDATE drivers SET fee_balance_pkr = fee_balance_pkr + $1 WHERE user_id = $2',
    [amountPkr, driverId],
  );
  await db.query(
    `INSERT INTO ledger_entries (driver_id, account, kind, amount_pkr, note)
     VALUES ($1, 'driver_fee_balance', 'topup', $2, $3)`,
    [driverId, amountPkr, note ?? null],
  );
}
