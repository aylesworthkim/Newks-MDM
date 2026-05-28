// Bootstrap the first admin account if -- and only if -- the users table
// has no admin yet AND ADMIN_USERNAME + ADMIN_PASSWORD are in the environment.
//
// This lets a fresh deployment get its first login without anyone having to
// hand-write SQL or insert a bcrypt hash. After the initial run, remove the
// ADMIN_PASSWORD line from .env (or rotate it) so plaintext credentials
// don't sit in the environment file.

import bcrypt from 'bcryptjs';
import { query } from './pool';

export async function bootstrapInitialAdmin(): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    // No bootstrap creds in env -- the normal case after the first run.
    return;
  }

  const existing = await query<{ count: string }>(
    `SELECT count(*) AS count FROM users WHERE role = 'admin'`,
  );
  if (Number(existing.rows[0].count) > 0) {
    // Already have at least one admin -- never overwrite.
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')`,
    [username, passwordHash],
  );
  // eslint-disable-next-line no-console
  console.log(`[bootstrap] created initial admin user "${username}"`);
}
