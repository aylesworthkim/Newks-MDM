// User management. CRUD for IT staff accounts. Admin-only -- support and
// viewer roles can't create or modify other users (would let support
// privilege-escalate themselves).
//
// Bootstrapping the very first admin is handled separately by
// db/bootstrap.ts using ADMIN_USERNAME/ADMIN_PASSWORD env vars. Once that
// admin exists, all subsequent users are created through this route.

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { query } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth, requireRole, type UserRole } from '../middleware/auth';
import { recordAudit } from '../services/audit';

export const usersRouter = Router();

interface UserListRow {
  id: string;
  username: string;
  role: UserRole;
  created_at: string;
}

const roleSchema = z.enum(['admin', 'support', 'viewer']);

// GET /api/users -- admin-only list of accounts. Never returns password_hash.
usersRouter.get(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await query<UserListRow>(
      `SELECT id, username, role, created_at
         FROM users
         ORDER BY created_at`,
    );
    res.json({ users: result.rows });
  }),
);

const createUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
  role: roleSchema,
});

// POST /api/users -- create a new user. Admin only. Returns the new row
// (without password_hash). Password is min 8 chars; if the operator wants
// to share with the new user out of band, they pick something reasonable.
usersRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body (username/password/role)' });
      return;
    }
    const username = parsed.data.username.trim();
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    try {
      const result = await query<UserListRow>(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id, username, role, created_at`,
        [username, passwordHash, parsed.data.role],
      );
      await recordAudit({
        actorUserId: req.user!.id,
        eventType: 'user.create',
        details: { userId: result.rows[0].id, username, role: parsed.data.role },
      });
      res.status(201).json({ user: result.rows[0] });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        res.status(409).json({ error: 'username already exists' });
        return;
      }
      throw err;
    }
  }),
);

// PATCH /api/users/:id -- update role and/or reset password. Admin only.
// Username is immutable to avoid breaking JWTs already in circulation.
// Cannot demote yourself away from admin (avoids accidental lockout).
const updateUserSchema = z.object({
  role: roleSchema.optional(),
  password: z.string().min(8).max(256).optional(),
});

usersRouter.patch(
  '/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    if (parsed.data.role === undefined && parsed.data.password === undefined) {
      res.status(400).json({ error: 'no fields to update' });
      return;
    }
    if (
      parsed.data.role &&
      parsed.data.role !== 'admin' &&
      req.user!.id === req.params.id
    ) {
      res.status(400).json({ error: 'cannot demote yourself; ask another admin' });
      return;
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (parsed.data.role !== undefined) {
      setClauses.push(`role = $${p++}`);
      params.push(parsed.data.role);
    }
    if (parsed.data.password !== undefined) {
      setClauses.push(`password_hash = $${p++}`);
      params.push(await bcrypt.hash(parsed.data.password, 12));
    }
    params.push(req.params.id);

    try {
      const result = await query<UserListRow>(
        `UPDATE users SET ${setClauses.join(', ')}
         WHERE id = $${p}
         RETURNING id, username, role, created_at`,
        params,
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      await recordAudit({
        actorUserId: req.user!.id,
        eventType: 'user.update',
        details: {
          userId: req.params.id,
          changes: {
            ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
            ...(parsed.data.password !== undefined ? { password: 'rotated' } : {}),
          },
        },
      });
      res.json({ user: result.rows[0] });
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid user id format' });
        return;
      }
      throw err;
    }
  }),
);

// DELETE /api/users/:id -- admin only. Refuses to delete the requesting
// user (avoids accidental self-lockout). Audit row references the deleted
// id even though the user is gone; the FK on audit_events allows NULL so
// nothing breaks.
usersRouter.delete(
  '/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    if (req.user!.id === req.params.id) {
      res.status(400).json({ error: 'cannot delete your own account' });
      return;
    }
    try {
      const result = await query<{ id: string; username: string }>(
        `DELETE FROM users WHERE id = $1 RETURNING id, username`,
        [req.params.id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      await recordAudit({
        actorUserId: req.user!.id,
        eventType: 'user.delete',
        details: { userId: req.params.id, username: result.rows[0].username },
      });
      res.status(204).end();
    } catch (err) {
      if ((err as { code?: string })?.code === '22P02') {
        res.status(400).json({ error: 'invalid user id format' });
        return;
      }
      throw err;
    }
  }),
);
