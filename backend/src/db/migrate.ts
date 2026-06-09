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

  // Groups: first-class store/folder entities for organizing devices. Devices
  // previously had a free-text `location_id` column; we keep that column
  // populated for backward compatibility but the source of truth is now
  // group_id (FK to groups.id). Frontend lists/filters/moves by group.
  await query(`
    CREATE TABLE IF NOT EXISTS groups (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL UNIQUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(
    `ALTER TABLE devices ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE SET NULL`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS devices_group_idx ON devices (group_id)`,
  );

  // One-time data migration: for each distinct non-empty location_id in the
  // existing devices table, ensure a matching group exists and link devices
  // to it. Idempotent -- safe to re-run.
  await query(`
    INSERT INTO groups (name)
    SELECT DISTINCT location_id FROM devices
    WHERE location_id IS NOT NULL AND TRIM(location_id) != ''
    ON CONFLICT (name) DO NOTHING
  `);
  await query(`
    UPDATE devices d
       SET group_id = g.id
      FROM groups g
     WHERE d.location_id = g.name
       AND d.group_id IS NULL
  `);

  // v0.7.2+: agent gained a CHECK_FOR_UPDATE command so support staff can
  // force the in-app updater to run on demand without waiting for the next
  // HeartbeatService start. Extend the commands.command_type CHECK
  // constraint to allow the new value. We have to DROP + CREATE because
  // Postgres CHECK constraints aren't extendable in place. The constraint
  // name follows Postgres's default naming for table-level CHECK
  // constraints (commands_command_type_check); if it was named differently
  // on an existing install we tolerate the missing-constraint error.
  await query(`
    ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_command_type_check
  `);
  await query(`
    ALTER TABLE commands ADD CONSTRAINT commands_command_type_check
      CHECK (command_type IN (
        'PING',
        'FETCH_DIAGNOSTICS',
        'OPEN_APP',
        'RESTART_APP',
        'CHECK_FOR_UPDATE'
      ))
  `);
}
