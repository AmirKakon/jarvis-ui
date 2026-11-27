// Shared Postgres access for modules without their own pool. With no
// DATABASE_URL every query returns no rows, so the bot runs (without
// persistence) in tests and on a box with no database.

import pg from 'pg';

let pool = null;

function getPool() {
  if (!pool) {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) return null;
    pool = new pg.Pool({ connectionString: connStr, max: 2 });
    pool.on('error', (err) => console.error('[db] pool error:', err.message));
  }
  return pool;
}

export async function query(sql, params = []) {
  const p = getPool();
  if (!p) return { rows: [], rowCount: 0 };
  return p.query(sql, params);
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
