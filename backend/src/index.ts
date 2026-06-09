// Backend entry point.
//
// Same process serves the API, the WebSocket endpoints, AND (in production)
// the built React frontend. nginx in front of us terminates TLS and forwards
// 443 -> 4000 on localhost; Node never sees plaintext bytes from anywhere
// but the local box.
//
// Dev (NODE_ENV != 'production'):
//   - Bind to 0.0.0.0 so the tablet on LAN can reach us during adb-reverse
//     or real-LAN testing.
//   - Do NOT serve the frontend -- Vite serves it on :5173 with HMR.
//
// Prod (NODE_ENV === 'production'):
//   - Bind to 127.0.0.1 only -- nginx is the public face, the backend has no
//     business being directly internet-reachable.
//   - Serve frontend/dist statically with a SPA fallback so client-side
//     routes (like /devices/:id) hit index.html.
//   - Trust the local nginx hop so req.ip and req.protocol reflect the real
//     client behind the proxy.

import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import { bootstrapInitialAdmin } from './db/bootstrap';
import { runMigrations } from './db/migrate';
import { query } from './db/pool';
import { authRouter } from './routes/auth';
import { commandsRouter } from './routes/commands';
import { devicesRouter } from './routes/devices';
import { groupsRouter } from './routes/groups';
import { deviceSessionsRouter, sessionsRouter } from './routes/sessions';
import { usersRouter } from './routes/users';
import { attachWebSocketServer } from './ws/server';

const isProduction = process.env.NODE_ENV === 'production';

function findLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    if (/^(vEthernet|VMware|VirtualBox|WSL|Loopback)/i.test(name)) continue;
    for (const info of interfaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return null;
}

function findFrontendDist(): string | null {
  // After `tsc` runs, this file lives at backend/dist/index.js so __dirname
  // is backend/dist. When developing with `tsx watch` it's backend/src.
  // Check both relative locations for the frontend build.
  const candidates = [
    path.resolve(__dirname, '../../frontend/dist'),
    path.resolve(__dirname, '../frontend/dist'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const app = express();
  const port = Number(process.env.PORT) || 4000;

  // Trust ONLY the local loopback proxy. Cloudways' nginx sits at 127.0.0.1,
  // so X-Forwarded-* from there is genuine. Anything from elsewhere is
  // ignored, which prevents a malicious client from spoofing their source IP
  // via injected headers.
  app.set('trust proxy', 'loopback');

  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // In production we serve the frontend from this same origin, so the
  // browser is always same-origin and CORS has nothing to do. The only
  // remaining CORS need would be a different admin frontend domain, which
  // operators can set via CORS_ORIGINS in env. In dev we accept any origin.
  app.use(cors({ origin: corsOrigins.length ? corsOrigins : (isProduction ? false : true) }));

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'remote-mdm-backend',
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/devices/:deviceId/commands', commandsRouter);
  app.use('/api/devices/:deviceId/sessions', deviceSessionsRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/users', usersRouter);

  // Production: serve the built React frontend. The SPA fallback returns
  // index.html for any non-/api, non-/ws path so React Router can take over
  // and the user can hit /devices/<uuid> directly or refresh on it.
  if (isProduction) {
    const distPath = findFrontendDist();
    if (distPath) {
      app.use(express.static(distPath, { maxAge: '1h', index: false }));
      app.get('*', (req: Request, res: Response, next: NextFunction) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
          return next();
        }
        res.sendFile(path.join(distPath, 'index.html'));
      });
      // eslint-disable-next-line no-console
      console.log(`[backend] serving frontend from ${distPath}`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[backend] NODE_ENV=production but no frontend/dist found. Did you run `npm run build` in frontend/?',
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('[server] unhandled error', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal server error' });
    }
  });

  await runMigrations();
  await bootstrapInitialAdmin();
  await query(`UPDATE devices SET status='offline' WHERE status='online'`);

  const server = http.createServer(app);
  attachWebSocketServer(server);

  const bindHost = isProduction ? '127.0.0.1' : '0.0.0.0';
  server.listen(port, bindHost, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[backend] listening on http://${bindHost}:${port} ` +
        `(NODE_ENV=${process.env.NODE_ENV ?? 'development'})`,
    );
    if (!isProduction) {
      const lan = findLanIp();
      if (lan) {
        // eslint-disable-next-line no-console
        console.log(`[backend] LAN reachable at http://${lan}:${port} (use this URL on the tablet)`);
      }
    }
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[backend] failed to start', err);
  process.exit(1);
});
