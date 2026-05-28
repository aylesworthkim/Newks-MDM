// Single pg.Pool instance shared by the whole backend. Importing this module
// is what creates the pool; the actual TCP connection happens lazily on first
// query. Every route that talks to Postgres goes through `query()` below.

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // Fail fast and loud rather than producing a confusing "connection refused"
  // later. (dotenv/config is loaded in src/index.ts before this module imports.)
  throw new Error(
    'DATABASE_URL is not set. Copy backend/.env.example to backend/.env and fill it in.',
  );
}

export const pool = new Pool({
  connectionString: databaseUrl,
  // Reasonable defaults for a dev backend; tune for prod load.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Surface DB errors instead of letting them tear down the process silently.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] unexpected error on idle pg client', err);
});

// Typed convenience wrapper so callers don't have to import QueryResult.
// Generic <T> is the row shape; pass it like: query<{ id: string }>(...).
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await pool.query(text, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}
