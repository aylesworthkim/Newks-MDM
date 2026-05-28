// JWT-based auth middleware.
//
//   requireAuth        -- rejects with 401 if no/invalid Bearer token;
//                         attaches the decoded user to req.user.
//   requireRole(...r)  -- runs after requireAuth; rejects with 403 if the
//                         authenticated user's role isn't in the list.
//
// Tokens are short-lived (8h) so a lost laptop expires automatically.

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export type UserRole = 'admin' | 'support' | 'viewer';

export interface AuthedUser {
  id: string;
  username: string;
  role: UserRole;
}

// Augment Express's Request type so req.user is properly typed everywhere.
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('JWT_SECRET is not set. Set it in backend/.env');
}

export function signToken(user: AuthedUser): string {
  // 8h is short enough that a stolen laptop expires before a support shift ends.
  return jwt.sign(user, jwtSecret!, { expiresIn: '8h' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    const payload = jwt.verify(match[1], jwtSecret!);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('id' in payload) ||
      !('username' in payload) ||
      !('role' in payload)
    ) {
      res.status(401).json({ error: 'malformed token' });
      return;
    }
    const { id, username, role } = payload as AuthedUser;
    req.user = { id, username, role };
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'insufficient role' });
      return;
    }
    next();
  };
}
