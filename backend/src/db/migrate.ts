// Idempotent on-startup migrations.
//
// docker-entrypoint-initdb.d/001-schema.sql only runs the FIRST time the
// postgres data volume is created. Anything we add later (like the
// sessions table for remote screen viewing) won't apply to existing dev
// installs unless we tear down the volume. Putting CREATE TABLE IF NOT
// EXISTS in this file and calling it on every backend startup is the
// simplest way to keep dev environments in sync without forcing volume
// resets every time we add a table.
//
// For production we'll want a real migration tool (e.g., node-pg-migrate)
// with version tracking. This is intentionally a stopgap.

import { query } from './pool';

export async function runMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id    UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
      status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'active', 'ended', 'failed')),
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at     TIMESTAMPTZ,
      end_reason   TEXT
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions (device_id, started_at DESC)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status)`,
  );

  // Readiness flags reported by the agent on every heartbeat. consent_armed
  // means the tablet has a cached MediaProjection token (IT can remote in
  // without the store manager tapping anything); accessibility_enabled means
  // remote control inputs (taps/swipes) will actually land on the screen.
  // Both default false until the agent reports otherwise.
  await query(
    `ALTER TABLE devices ADD COLUMN IF NOT EXISTS consent_armed BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await query(
    `ALTER TABLE devices ADD COLUMN IF NOT EXISTS accessibility_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  );
}
