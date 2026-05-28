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

    const result = await query<{ id: string }>(
      `INSERT INTO devices (serial_number, device_name, model, android_version, location_id, agent_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (serial_number) DO UPDATE SET
         device_name     = EXCLUDED.device_name,
         model           = EXCLUDED.model,
         android_version = EXCLUDED.android_version,
         location_id     = EXCLUDED.location_id,
         agent_version   = EXCLUDED.agent_version,
         status          = 'enrolled'
       RETURNING id`,
      [
        body.serialNumber,
        body.deviceName,
        body.model ?? null,
        body.androidVersion ?? null,
        body.locationId ?? null,
        body.agentVersion ?? null,
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
      `SELECT id, serial_number, device_name, model, android_version, location_id,
              agent_version, status, enrolled_at, last_heartbeat_at,
              consent_armed, accessibility_enabled
       FROM devices
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
        `SELECT id, serial_number, device_name, model, android_version, location_id,
                agent_version, status, enrolled_at, last_heartbeat_at
         FROM devices
         WHERE id = $1`,
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
// it to a different store. We deliberately do NOT expose this to enrollment
// (devices can't rename themselves; that goes through the admin UI).
// Empty-string locationId clears the field (device moves to the "Unassigned"
// bucket in the portal); to leave a field alone, just omit it from the body.
const updateDeviceSchema = z.object({
  deviceName: z.string().min(1).max(128).optional(),
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
    if (parsed.data.deviceName === undefined && parsed.data.locationId === undefined) {
      res.status(400).json({ error: 'no fields to update' });
      return;
    }

    // Build the UPDATE dynamically so an unspecified field stays untouched
    // (vs being clobbered to null on every PATCH).
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (parsed.data.deviceName !== undefined) {
      setClauses.push(`device_name = $${p++}`);
      params.push(parsed.data.deviceName);
    }
    if (parsed.data.locationId !== undefined) {
      setClauses.push(`location_id = $${p++}`);
      // Empty string -> NULL so the row ends up in the "Unassigned" bucket
      // rather than carrying a literal empty store id.
      params.push(parsed.data.locationId === '' ? null : parsed.data.locationId);
    }
    params.push(req.params.id);

    try {
      const result = await query<DeviceRow>(
        `UPDATE devices SET ${setClauses.join(', ')}
         WHERE id = $${p}
         RETURNING id, serial_number, device_name, model, android_version, location_id,
                   agent_version, status, enrolled_at, last_heartbeat_at,
                   consent_armed, accessibility_enabled`,
        params,
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'device not found' });
        return;
      }

      const changes: Record<string, unknown> = {};
      if (parsed.data.deviceName !== undefined) changes.deviceName = parsed.data.deviceName;
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
