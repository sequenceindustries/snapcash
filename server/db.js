import pg from 'pg';
import { config } from './config.js';

// Return numeric columns as JS numbers (amounts are small, 2 decimals) and dates as YYYY-MM-DD strings.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

const needsSsl = config.databaseUrl && !/localhost|127\.0\.0\.1|\.railway\.internal|host=\/|@\/|%2F/.test(config.databaseUrl)
  && !/sslmode=disable/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX) || 10,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

// Runs fn(client) inside a transaction.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
