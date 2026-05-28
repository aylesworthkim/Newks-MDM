// Tiny wrapper so an async route handler's rejected promise reaches Express's
// error-handling middleware instead of crashing the process.
//
// Express 4 does NOT automatically forward rejected promises to next(err);
// you have to either catch errors yourself in every handler, or wrap each
// async handler with something like this. We chose to wrap.
//
// Usage:
//   router.get('/foo', asyncHandler(async (req, res) => { ... }));

import type { NextFunction, Request, Response } from 'express';

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
