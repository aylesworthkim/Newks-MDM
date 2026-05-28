-- Initial schema for Remote Device Management.
--
-- docker-compose.yml mounts this file into the postgres container's
-- /docker-entrypoint-initdb.d/ directory, so it runs automatically the first
-- time the postgres data volume is created. After that, edits here do NOT
-- re-run on container restart -- to apply a schema change later, either:
--   1. Tear down the volume:  docker compose down -v   (DESTROYS DATA)
--   2. Or write a real migration script and run it against the running DB.

-- ---------------------------------------------------------------------------
-- Users: admin portal accounts (NOT device users / not POS staff).
-- Roles control what an authenticated user can see and do.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                                   -- bcrypt hash, never plaintext
  role          TEXT NOT NULL CHECK (role IN ('admin', 'support', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Devices: each enrolled POS tablet.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number     TEXT UNIQUE NOT NULL,                        -- hardware serial, unique per device
  device_name       TEXT NOT NULL,                               -- friendly name for support staff
  model             TEXT,
  android_version   TEXT,
  location_id       TEXT,                                        -- Newk's store / location identifier
  agent_version     TEXT,
  status            TEXT NOT NULL DEFAULT 'enrolled'
                       CHECK (status IN ('enrolled', 'online', 'offline', 'retired')),
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS devices_location_idx ON devices (location_id);
CREATE INDEX IF NOT EXISTS devices_status_idx   ON devices (status);

-- ---------------------------------------------------------------------------
-- Commands: queue of allowlisted actions support staff can send to devices.
--
-- The command_type column is constrained to a hard-coded allowlist via a
-- CHECK constraint. This makes it structurally impossible to write a row
-- that asks the device to run an arbitrary shell command -- a critical
-- guardrail given these are production POS tablets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commands (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,    -- null if user is later deleted
  command_type  TEXT NOT NULL
                  CHECK (command_type IN (
                    'PING',
                    'FETCH_DIAGNOSTICS',
                    'OPEN_APP',
                    'RESTART_APP'
                  )),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,              -- e.g. { "package": "com.newks.pos" }
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'dispatched', 'completed', 'failed', 'expired')),
  result        JSONB,                                           -- populated when the device reports back
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commands_device_idx ON commands (device_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS commands_status_idx ON commands (status);

-- ---------------------------------------------------------------------------
-- Audit events: append-only log of every meaningful action.
--
-- Examples of event_type values we'll emit later: 'user.login',
-- 'device.enroll', 'command.request', 'command.dispatch', 'session.start',
-- 'session.stop', 'role.change'. We deliberately use TEXT (not an enum) so
-- new event types can be added without a schema migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_device_idx ON audit_events (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx  ON audit_events (actor_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Sessions: remote screen viewing / control sessions. Each row is one
-- support staff -> device session, tracked from request through end.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'active', 'ended', 'failed')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  end_reason   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions (device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status);
