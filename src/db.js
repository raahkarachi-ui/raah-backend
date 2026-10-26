import pg from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.js';

// Neon: keep ?sslmode=require on DATABASE_URL and `pg` turns TLS on by itself.
// Neon suspends idle databases, so allow time for a cold start and don't let a
// dropped idle connection crash the process.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});
pool.on('error', (err) => console.error('Idle pg client error:', err.message));

export function createRedis() {
  const redis = new Redis(config.redisUrl, {
    // Fail fast instead of queueing commands forever when Redis is not running.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 1000, 10_000),
  });
  redis.on('error', () => {}); // outages are reported once by bestEffort()
  return redis;
}

/** Runs `fn` in a transaction on one connection; rolls back on any throw. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Newest petrol price row. Pass a transaction client to read inside it. */
export async function currentFuelPrice(db = pool) {
  const { rows } = await db.query(
    'SELECT id, price_pkr_per_l FROM fuel_prices ORDER BY effective_from DESC, id DESC LIMIT 1',
  );
  return rows[0];
}
