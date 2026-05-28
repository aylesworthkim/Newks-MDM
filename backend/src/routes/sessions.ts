// Session HTTP routes:
//   POST   /api/devices/:deviceId/sessions  -- start a session (admin/support)
//   DELETE /api/sessions/:id                -- stop a session  (admin/support)
//   GET    /api/sessions/:id                -- session info    (any auth)

import { Router, type Request, type Response } from 'express';

import { query } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAudit } from '../services/audit';
import {
  finalizeSession,
  trackSession,
} from '../ws/sessions';
import { sendToDevice } from '../ws/server';

export const sessionsRouter = Router();
export const deviceSessionsRouter = Router({ mergeParams: true });

// POST /api/devices/:deviceId/sessions
deviceSessionsRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'support'),
  asyncHandler(async (req: Request, res: Response) => {
    const deviceId = req.params.deviceId;

    // Verify the device exists. Reuses the same 22P02 -> 400 trick from
    // the commands router.
    try {
      const dev = await query(`SELECT id FROM devices WHERE id=$1`, [deviceId]);
      if (dev.rows.length === 0) {
        res.status(404).json({ error: 'device not found' });
        return;
      }
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid device id format' });
        return;
      }
      throw err;
    }

    // Insert with status='pending'. The device must respond with
    // SESSION_STARTED for it to flip to 'active'.
    const inserted = await query<{ id: string }>(
      `INSERT INTO sessions (device_id, requested_by, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [deviceId, req.user!.id],
    );
    const sessionId = inserted.rows[0].id;

    trackSession(sessionId, deviceId);

    await recordAudit({
      actorUserId: req.user!.id,
      deviceId,
      eventType: 'session.start.request',
      details: { sessionId },
    });

    // Tell the device to start capture. If the device is offline this
    // returns false; we still leave the session row in 'pending' so the
    // UI can show "waiting for device".
    const delivered = sendToDevice(deviceId, JSON.stringify({
      type: 'START_SESSION',
      sessionId,
    }));

    res.status(201).json({
      sessionId,
      status: 'pending',
      deviceOnline: delivered,
    });
  }),
);

// DELETE /api/sessions/:id
sessionsRouter.delete(
  '/:id',
  requireAuth,
  requireRole('admin', 'support'),
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.params.id;

    // Look up the device so we can address the STOP_SESSION message.
    let deviceId: string;
    try {
      const row = await query<{ device_id: string; status: string }>(
        `SELECT device_id, status FROM sessions WHERE id=$1`,
        [sessionId],
      );
      if (row.rows.length === 0) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      deviceId = row.rows[0].device_id;
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid session id format' });
        return;
      }
      throw err;
    }

    sendToDevice(deviceId, JSON.stringify({ type: 'STOP_SESSION', sessionId }));
    await finalizeSession(sessionId, `stopped by ${req.user!.username}`);

    res.json({ status: 'ended' });
  }),
);

// GET /api/sessions/:id
sessionsRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.params.id;
    try {
      const result = await query<{
        id: string;
        device_id: string;
        requested_by: string | null;
        status: string;
        started_at: string;
        ended_at: string | null;
        end_reason: string | null;
      }>(
        `SELECT id, device_id, requested_by, status, started_at, ended_at, end_reason
         FROM sessions WHERE id=$1`,
        [sessionId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      res.json({ session: result.rows[0] });
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid session id format' });
        return;
      }
      throw err;
    }
  }),
);
