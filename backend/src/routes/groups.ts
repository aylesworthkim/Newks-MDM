// Groups (stores) CRUD. A "group" is a named bucket of devices, typically
// representing a Newk's store location (e.g., "1003"). The frontend uses
// groups to organize the device list, drive the "move to..." dropdown on
// each device, and gate bulk operations.
//
// History: pre-Groups, devices had a free-text `location_id` column with
// the store name typed in directly. The migrate.ts hook auto-creates groups
// from those existing strings on first run and links devices via FK. The
// location_id column is kept for backward compatibility but should be
// considered deprecated; new writes go to group_id.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAudit } from '../services/audit';

export const groupsRouter = Router();

interface GroupRow {
  id: string;
  name: string;
  created_at: string;
  device_count: number;
}

// GET /api/groups -- list all groups with device counts. Any authenticated
// user can read; viewers see the same list as admins.
groupsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<GroupRow>(
      `SELECT g.id, g.name, g.created_at,
              COUNT(d.id)::int AS device_count
         FROM groups g
         LEFT JOIN devices d ON d.group_id = g.id
        GROUP BY g.id, g.name, g.created_at
        ORDER BY g.name`,
    );
    res.json({ groups: result.rows });
  }),
);

const createGroupSchema = z.object({
  name: z.string().min(1).max(64),
});

// POST /api/groups -- admins + support can create a new group.
groupsRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'support'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    const name = parsed.data.name.trim();
    try {
      const result = await query<GroupRow>(
        `INSERT INTO groups (name) VALUES ($1)
         RETURNING id, name, created_at, 0::int AS device_count`,
        [name],
      );
      await recordAudit({
        actorUserId: req.user!.id,
        eventType: 'group.create',
        details: { groupId: result.rows[0].id, name },
      });
      res.status(201).json({ group: result.rows[0] });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        // unique_violation on name
        res.status(409).json({ error: 'a group with that name already exists' });
        return;
      }
      throw err;
    }
  }),
);

const updateGroupSchema = z.object({
  name: z.string().min(1).max(64),
});

// PATCH /api/groups/:id -- rename a group. Cascades nothing -- devices keep
// their group_id, they just see the new name on next fetch.
groupsRouter.patch(
  '/:id',
  requireAuth,
  requireRole('admin', 'support'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    const name = parsed.data.name.trim();
    try {
      const result = await query<GroupRow>(
        `UPDATE groups SET name = $1 WHERE id = $2
         RETURNING id, name, created_at,
                   (SELECT COUNT(*)::int FROM devices WHERE group_id = groups.id) AS device_count`,
        [name, req.params.id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'group not found' });
        return;
      }
      await recordAudit({
        actorUserId: req.user!.id,
        eventType: 'group.rename',
        details: { groupId: req.params.id, name },
      });
      res.json({ group: result.rows[0] });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        res.status(409).json({ error: 'a group with that name already exists' });
        return;
      }
      if (code === '22P02') {
        res.status(400).json({ error: 'invalid group id format' });
        return;
      }
      throw err;
    }
  }),
);

// DELETE /api/groups/:id -- admin only. Devices in the group get group_id
// nullified (ON DELETE SET NULL); they show under "Unassigned" until moved.
groupsRouter.delete(
  '/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await query<{ id: string; name: string }>(
        `DELETE FROM groups WHERE id = $1 RETURNING id, name`,
        [req.params.id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'group not found' });
        return;
      }
      await recordAudit({
        actorUserId: req.user!.id,
        eventType: 'group.delete',
        details: { groupId: req.params.id, name: result.rows[0].name },
      });
      res.status(204).end();
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid group id format' });
        return;
      }
      throw err;
    }
  }),
);
