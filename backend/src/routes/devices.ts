// Device routes:
//   POST /api/devices/enroll  -- called BY the device; authenticated only by
//                                the shared ENROLLMENT_SECRET (no JWT, because
//                                the device doesn't have a user account).
//   GET  /api/devices         -- list devices (any authenticated portal user).
//   GET  /api/devices/:id     -- single device detail (any authenticated user).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAudit } from '../services/audit';

export const devicesRouter = Router();

const enrollmentSecret = process.env.ENROLLMENT_SECRET;
if (!enrollmentSecret) {
  throw new Error('ENROLLMENT_SECRET is not set. Set it in backend/.env');
}

const enrollSchema = z.object({
  enrollmentSecret: z.string(),
  serialNumber: z.string().min(1).max(128),
  deviceName: z.string().min(1).max(128),
  model: z.string().max(128).optional(),
  androidVersion: z.string().max(32).optional(),
  locationId: z.string().max(64).optional(),
  agentVersion: z.string().max(32).optional(),
});

interface DeviceRow {
  id: string;
  serial_number: string;
  device_name: string;
  model: string | null;
  android_version: string | null;
  location_id: string | null;
  agent_version: string | null;
  status: string;
  enrolled_at: string;
  last_heartbeat_at: string | null;
  consent_armed: boolean;
  accessibility_enabled: boolean;
  group_id: string | null;
  group_name: string | null;
}

// Enroll a device. On a re-enrollment (factory reset, same serial number) we
// update the existing row rather than create a duplicate -- ON CONFLICT below.
// The returned `deviceId` is what the device should store and present on
// future heartbeats (which will eventually carry a per-device token).
devicesRouter.post(
  '/enroll',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    const body = parsed.data;

    if (body.enrollmentSecret !== enrollmentSecret) {
      await recordAudit({
        eventType: 'device.enroll.rejected',
        details: { reason: 'bad_secret', serialNumber: body.serialNumber },
      });
      res.status(401).json({ error: 'invalid enrollment secret' });
      return;
    }

    // If the device sent a non-empty locationId, ensure a matching group
    // exists and link to it. Devices auto-join their store's group at
    // enrollment time so the portal doesn't need a manual "assign group"
    // step for fresh tablets.
    let groupId: string | null = null;
    const trimmedLocation = body.locationId?.trim();
    if (trimmedLocation) {
      const grp = await query<{ id: string }>(
        `INSERT INTO groups (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [trimmedLocation],
      );
      groupId = grp.rows[0].id;
    }

    const result = await query<{ id: string }>(
      `INSERT INTO devices (serial_number, device_name, model, android_version, location_id, agent_version, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (serial_number) DO UPDATE SET
         device_name     = EXCLUDED.device_name,
         model           = EXCLUDED.model,
         android_version = EXCLUDED.android_version,
         location_id     = EXCLUDED.location_id,
         agent_version   = EXCLUDED.agent_version,
         group_id        = EXCLUDED.group_id,
         status          = 'enrolled'
       RETURNING id`,
      [
        body.serialNumber,
        body.deviceName,
        body.model ?? null,
        body.androidVersion ?? null,
        body.locationId ?? null,
        body.agentVersion ?? null,
        groupId,
      ],
    );

    const deviceId = result.rows[0].id;
    await recordAudit({
      deviceId,
      eventType: 'device.enroll.success',
      details: { serialNumber: body.serialNumber, locationId: body.locationId ?? null },
    });

    res.status(201).json({ deviceId });
  }),
);

devicesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<DeviceRow>(
      `SELECT d.id, d.serial_number, d.device_name, d.model, d.android_version,
              d.location_id, d.agent_version, d.status, d.enrolled_at,
              d.last_heartbeat_at, d.consent_armed, d.accessibility_enabled,
              d.group_id, g.name AS group_name
       FROM devices d
       LEFT JOIN groups g ON g.id = d.group_id
       ORDER BY enrolled_at DESC`,
    );
    res.json({ devices: result.rows });
  }),
);

devicesRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await query<DeviceRow>(
        `SELECT d.id, d.serial_number, d.device_name, d.model, d.android_version,
                d.location_id, d.agent_version, d.status, d.enrolled_at,
                d.last_heartbeat_at, d.consent_armed, d.accessibility_enabled,
                d.group_id, g.name AS group_name
         FROM devices d
         LEFT JOIN groups g ON g.id = d.group_id
         WHERE d.id = $1`,
        [req.params.id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'device not found' });
        return;
      }
      res.json({ device: result.rows[0] });
    } catch (err) {
      // Postgres throws 22P02 for "invalid input syntax for type uuid".
      // Treat as a 400 rather than a 500 so the client gets a useful message.
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid device id format' });
        return;
      }
      throw err;
    }
  }),
);

// PATCH /api/devices/:id -- portal admins/support can rename a device or move
// it to a different group. Accepts:
//   - deviceName: rename
//   - groupId: UUID of target group, or null to unassign
//   - locationId (deprecated, kept for compat): free-text; sets location_id
//     and finds/creates a group with that name.
// Empty/null groupId moves the device to "Unassigned". Omit a field to
// leave it untouched.
const updateDeviceSchema = z.object({
  deviceName: z.string().min(1).max(128).optional(),
  groupId: z.string().uuid().nullable().optional(),
  locationId: z.string().max(64).optional(),
});

devicesRouter.patch(
  '/:id',
  requireAuth,
  requireRole('admin', 'support'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    if (
      parsed.data.deviceName === undefined &&
      parsed.data.groupId === undefined &&
      parsed.data.locationId === undefined
    ) {
      res.status(400).json({ error: 'no fields to update' });
      return;
    }

    // If groupId provided, verify the group exists and grab its name so we
    // can keep location_id in sync for backward-compat displays.
    let resolvedGroupId: string | null | undefined = undefined;
    let resolvedLocationFromGroup: string | null | undefined = undefined;
    if (parsed.data.groupId !== undefined) {
      if (parsed.data.groupId === null) {
        resolvedGroupId = null;
        resolvedLocationFromGroup = null;
      } else {
        const g = await query<{ id: string; name: string }>(
          `SELECT id, name FROM groups WHERE id = $1`,
          [parsed.data.groupId],
        );
        if (g.rows.length === 0) {
          res.status(400).json({ error: 'group not found' });
          return;
        }
        resolvedGroupId = g.rows[0].id;
        resolvedLocationFromGroup = g.rows[0].name;
      }
    }

    // If legacy locationId provided (and no groupId), look up or create a
    // matching group and link via group_id too. This keeps old API callers
    // working without a separate group-creation step.
    let resolvedLocationFromLocationId: string | null | undefined = undefined;
    if (parsed.data.locationId !== undefined && parsed.data.groupId === undefined) {
      const trimmed = parsed.data.locationId.trim();
      if (trimmed === '') {
        resolvedGroupId = null;
        resolvedLocationFromLocationId = null;
      } else {
        const grp = await query<{ id: string }>(
          `INSERT INTO groups (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [trimmed],
        );
        resolvedGroupId = grp.rows[0].id;
        resolvedLocationFromLocationId = trimmed;
      }
    }

    // Build the UPDATE dynamically. Skipping unspecified fields keeps them
    // untouched rather than clobbering to null.
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (parsed.data.deviceName !== undefined) {
      setClauses.push(`device_name = $${p++}`);
      params.push(parsed.data.deviceName);
    }
    if (resolvedGroupId !== undefined) {
      setClauses.push(`group_id = $${p++}`);
      params.push(resolvedGroupId);
    }
    // Always keep location_id mirroring the group's name for compatibility
    // with any external system still reading that column.
    const newLocation =
      resolvedLocationFromGroup !== undefined
        ? resolvedLocationFromGroup
        : resolvedLocationFromLocationId;
    if (newLocation !== undefined) {
      setClauses.push(`location_id = $${p++}`);
      params.push(newLocation);
    }
    params.push(req.params.id);

    try {
      // CTE: update devices, then join groups for the response.
      const result = await query<DeviceRow>(
        `WITH updated AS (
           UPDATE devices SET ${setClauses.join(', ')}
           WHERE id = $${p}
           RETURNING *
         )
         SELECT u.id, u.serial_number, u.device_name, u.model, u.android_version,
                u.location_id, u.agent_version, u.status, u.enrolled_at,
                u.last_heartbeat_at, u.consent_armed, u.accessibility_enabled,
                u.group_id, g.name AS group_name
         FROM updated u
         LEFT JOIN groups g ON g.id = u.group_id`,
        params,
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'device not found' });
        return;
      }

      const changes: Record<string, unknown> = {};
      if (parsed.data.deviceName !== undefined) changes.deviceName = parsed.data.deviceName;
      if (parsed.data.groupId !== undefined) changes.groupId = parsed.data.groupId;
      if (parsed.data.locationId !== undefined) changes.locationId = parsed.data.locationId;
      await recordAudit({
        actorUserId: req.user!.id,
        deviceId: req.params.id,
        eventType: 'device.update',
        details: { changes },
      });

      res.json({ device: result.rows[0] });
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid device id format' });
        return;
      }
      throw err;
    }
  }),
);
