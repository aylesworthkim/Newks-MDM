// Per-device command routes, mounted at /api/devices/:deviceId/commands.
//
//   GET  /  -- list commands for a device (any authenticated user).
//   POST /  -- enqueue a new command (admin or support only).
//
// SAFETY: the command_type allowlist is enforced in THREE places.
//   1. Zod schema below (rejected with 400 before touching the DB).
//   2. CHECK constraint on commands.command_type (DB-side guardrail).
//   3. The Android agent itself ignores anything that's not a known type.
// All three layers must agree. To add a new command type:
//   - Add a literal here
//   - Add it to the CHECK constraint in docs/database-schema.sql + migrate
//   - Teach the agent to handle it
// This deliberately makes adding command types annoying. Arbitrary shell
// execution is what we never want, ever, on a fleet of POS tablets.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAudit } from '../services/audit';
import { dispatchCommandsToDevice } from '../ws/server';

// mergeParams lets this child router see :deviceId from the parent mount path.
export const commandsRouter = Router({ mergeParams: true });

const issueCommandSchema = z.discriminatedUnion('commandType', [
  z.object({
    commandType: z.literal('PING'),
    payload: z.object({}).strict().optional(),
  }),
  z.object({
    commandType: z.literal('FETCH_DIAGNOSTICS'),
    payload: z.object({}).strict().optional(),
  }),
  z.object({
    commandType: z.literal('OPEN_APP'),
    // Strict object so an attacker can't smuggle extra fields the agent
    // might be tempted to interpret loosely later.
    payload: z.object({ package: z.string().min(1).max(256) }).strict(),
  }),
  z.object({
    commandType: z.literal('RESTART_APP'),
    payload: z.object({ package: z.string().min(1).max(256) }).strict(),
  }),
]);

interface CommandRow {
  id: string;
  command_type: string;
  payload: Record<string, unknown>;
  status: string;
  requested_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  requested_by_username: string | null;
}

// Verify the device exists. Used by both GET and POST -- a 404 here is
// cleaner than a successful "empty history" or a silently-inserted row
// against a deleted device. Returns true if the caller should continue.
async function deviceExists(deviceId: string, res: Response): Promise<boolean> {
  try {
    const result = await query<{ id: string }>(
      `SELECT id FROM devices WHERE id = $1`,
      [deviceId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'device not found' });
      return false;
    }
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === '22P02') {
      res.status(400).json({ error: 'invalid device id format' });
      return false;
    }
    throw err;
  }
}

commandsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const deviceId = req.params.deviceId;
    if (!(await deviceExists(deviceId, res))) return;

    const result = await query<CommandRow>(
      `SELECT c.id, c.command_type, c.payload, c.status,
              c.requested_at, c.dispatched_at, c.completed_at, c.result,
              u.username AS requested_by_username
       FROM commands c
       LEFT JOIN users u ON u.id = c.requested_by
       WHERE c.device_id = $1
       ORDER BY c.requested_at DESC
       LIMIT 100`,
      [deviceId],
    );
    res.json({ commands: result.rows });
  }),
);

commandsRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'support'),
  asyncHandler(async (req: Request, res: Response) => {
    const deviceId = req.params.deviceId;
    if (!(await deviceExists(deviceId, res))) return;

    const parsed = issueCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid command request' });
      return;
    }
    const { commandType } = parsed.data;
    const payload = 'payload' in parsed.data && parsed.data.payload ? parsed.data.payload : {};

    const inserted = await query<{ id: string }>(
      `INSERT INTO commands (device_id, requested_by, command_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [deviceId, req.user!.id, commandType, JSON.stringify(payload)],
    );

    const commandId = inserted.rows[0].id;
    // Required by prompt 01: every command request creates an audit event.
    await recordAudit({
      actorUserId: req.user!.id,
      deviceId,
      eventType: 'command.request',
      details: { commandId, commandType, payload },
    });

    // Push the command immediately to the device's open WebSocket, if any.
    // If the device is offline the command stays 'queued' and gets sent on
    // its next REGISTER_SOCKET. Failures here are logged but don't fail the
    // request -- the row is already in the DB.
    try {
      await dispatchCommandsToDevice(deviceId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[commands] dispatch failed', err);
    }

    res.status(201).json({ commandId, status: 'queued' });
  }),
);
