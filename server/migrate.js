// Applies migrations/*.sql in filename order, once each. Runs on every boot and via `npm run migrate`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  const client = await pool.connect();
  try {
    // Serialise concurrent boots (e.g. two replicas starting together).
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [file]);
        await client.query('commit');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => { console.log('[migrate] up to date'); return pool.end(); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
