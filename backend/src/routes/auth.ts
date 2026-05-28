// Auth routes:
//   POST /api/auth/login -- exchange username + password for a JWT.
//   GET  /api/auth/me    -- echo back the authenticated user (for the UI).

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { query } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth, signToken, type UserRole } from '../middleware/auth';
import { recordAudit } from '../services/audit';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
}

// A fixed bcrypt hash used only as a dummy compare target when the username
// doesn't exist. Running bcrypt.compare against it keeps response timing
// roughly constant so an attacker can't enumerate valid usernames by latency.
const DUMMY_HASH = '$2a$12$abcdefghijklmnopqrstuv.0123456789ABCDEFGHIJKLMNOPQRSTUVWX';

authRouter.post(
  '/login',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    const { username, password } = parsed.data;

    const result = await query<UserRow>(
      `SELECT id, username, password_hash, role FROM users WHERE username = $1`,
      [username],
    );

    const row = result.rows[0];
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      await recordAudit({ eventType: 'user.login.failed', details: { username } });
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    const token = signToken({ id: row.id, username: row.username, role: row.role });
    await recordAudit({
      actorUserId: row.id,
      eventType: 'user.login.success',
      details: { username: row.username },
    });

    res.json({
      token,
      user: { id: row.id, username: row.username, role: row.role },
    });
  }),
);

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});
