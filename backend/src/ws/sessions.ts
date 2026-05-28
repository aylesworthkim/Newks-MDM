// Session manager. Owns the in-process state for active remote-screen
// sessions: which device each session is for, which browser sockets are
// currently viewing it, and the lifecycle transitions.
//
// This module is the single bridge between:
//   - The device WebSocket (ws/server.ts) -- accepts frames + ack messages
//   - The browser WebSocket (attached below) -- pushes frames out, accepts
//     input events to forward to the device.
//   - The HTTP routes (routes/sessions.ts) -- starts/stops sessions.
//
// SECURITY: Browser WS upgrade authenticates via a JWT in the `token` query
// param. We don't have a header-based path for WebSocket auth that works in
// every browser, and the connection is server-to-server-to-server within
// our own infrastructure. Token-in-URL is acceptable here for MVP; rotate
// to per-session tokens before production.

import type { IncomingMessage, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { query } from '../db/pool';
import { recordAudit } from '../services/audit';

const jwtSecret = process.env.JWT_SECRET!;

// Allowed roles for opening a viewer session. Viewers can see-only; that's
// enforced when interpreting incoming browser messages (input events are
// rejected from viewer-role users).
const VIEWER_ROLES = new Set(['admin', 'support', 'viewer']);
const CONTROLLER_ROLES = new Set(['admin', 'support']);

interface SessionState {
  sessionId: string;
  deviceId: string;
  // Browsers currently watching this session.
  browsers: Set<WebSocket>;
  // Track when we started so we can audit duration on close.
  startedAt: number;
  // Count of inputs sent (audited at session end as a summary).
  inputCount: number;
}

const sessions = new Map<string, SessionState>();

// Called from device WebSocket when a frame or session-state message arrives.
export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

// Called from routes/sessions.ts when a session row is inserted with status='pending'.
// Registers state so the device's SESSION_STARTED message has somewhere to land.
export function trackSession(sessionId: string, deviceId: string): void {
  if (sessions.has(sessionId)) return;
  sessions.set(sessionId, {
    sessionId,
    deviceId,
    browsers: new Set(),
    startedAt: Date.now(),
    inputCount: 0,
  });
}

export function untrackSession(sessionId: string): SessionState | undefined {
  const state = sessions.get(sessionId);
  if (!state) return undefined;
  sessions.delete(sessionId);
  // Close any still-attached browsers so they fall back to the "session
  // ended" UI.
  for (const ws of state.browsers) {
    try {
      ws.send(JSON.stringify({ type: 'SESSION_ENDED', sessionId }));
      ws.close(1000, 'session ended');
    } catch {
      // ignore -- the browser may already be gone
    }
  }
  return state;
}

// Push a frame OR a state message to every browser currently viewing this session.
export function broadcastToBrowsers(sessionId: string, message: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  for (const ws of state.browsers) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

// Incoming-from-browser message shapes. Outputs (frames) are passed through
// from the device unchanged.
const browserInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('INPUT_TAP'),
    // Coordinates are proportional in [0, 1] so the protocol is independent
    // of both the browser viewport size and the device's actual screen size.
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('INPUT_SWIPE'),
    fromX: z.number().min(0).max(1),
    fromY: z.number().min(0).max(1),
    toX: z.number().min(0).max(1),
    toY: z.number().min(0).max(1),
    durationMs: z.number().int().min(50).max(3000).default(200),
  }),
  z.object({
    type: z.literal('INPUT_KEY'),
    // System keys we support. Letter/digit injection is out of scope for MVP.
    key: z.enum(['BACK', 'HOME', 'RECENTS']),
  }),
]);

export function attachSessionWebSocketServer(
  httpServer: HttpServer,
  forwardInputToDevice: (deviceId: string, payload: string) => void,
): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url) return;
    // Match /ws/sessions/<uuid>?token=...
    const match = req.url.match(/^\/ws\/sessions\/([0-9a-f-]+)(?:\?(.*))?$/i);
    if (!match) return; // not for us -- ws/server.ts handles /ws

    const sessionId = match[1];
    const params = new URLSearchParams(match[2] ?? '');
    const token = params.get('token');

    // Validate JWT before completing the upgrade.
    type SessionUser = { id: string; username: string; role: string };
    let user: SessionUser | null = null;
    try {
      if (!token) throw new Error('missing token');
      const payload = jwt.verify(token, jwtSecret);
      if (
        typeof payload === 'object' && payload !== null &&
        'id' in payload && 'username' in payload && 'role' in payload
      ) {
        user = payload as SessionUser;
      }
    } catch {
      // Fall through to destroy below.
    }

    if (!user || !VIEWER_ROLES.has(user.role)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachBrowserSocket(ws, session, user!, forwardInputToDevice);
    });
  });
}

function attachBrowserSocket(
  ws: WebSocket,
  session: SessionState,
  user: { id: string; username: string; role: string },
  forwardInputToDevice: (deviceId: string, payload: string) => void,
): void {
  session.browsers.add(ws);
  ws.send(JSON.stringify({ type: 'SESSION_ATTACHED', sessionId: session.sessionId }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = browserInputSchema.parse(JSON.parse(raw.toString()));
    } catch {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'invalid input message' }));
      return;
    }

    // RBAC: viewer role can WATCH but can't send inputs.
    if (!CONTROLLER_ROLES.has(user.role)) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'insufficient role for input' }));
      return;
    }

    // Forward to the device WebSocket, tagging with the sessionId so the
    // device knows which capture session this input belongs to.
    forwardInputToDevice(
      session.deviceId,
      JSON.stringify({ ...msg, sessionId: session.sessionId }),
    );

    session.inputCount += 1;
    // Per-event audit. High-volume for a long swipe but cheap on Postgres
    // and gives us the full input trail per session for compliance.
    await recordAudit({
      actorUserId: user.id,
      deviceId: session.deviceId,
      eventType: 'session.input',
      details: { sessionId: session.sessionId, input: msg },
    });
  });

  ws.on('close', () => {
    session.browsers.delete(ws);
  });
}

// Called from routes/sessions.ts when stopping a session OR from ws/server.ts
// when a device-side stop arrives. Marks the row 'ended' and emits the
// summary audit event.
export async function finalizeSession(
  sessionId: string,
  reason: string,
  endStatus: 'ended' | 'failed' = 'ended',
): Promise<void> {
  const state = untrackSession(sessionId);
  await query(
    `UPDATE sessions SET status=$1, ended_at=now(), end_reason=$2 WHERE id=$3 AND status != 'ended'`,
    [endStatus, reason, sessionId],
  );
  if (state) {
    await recordAudit({
      deviceId: state.deviceId,
      eventType: endStatus === 'failed' ? 'session.failed' : 'session.end',
      details: {
        sessionId,
        durationMs: Date.now() - state.startedAt,
        inputCount: state.inputCount,
        reason,
      },
    });
  }
}

// Update sessions row when the device confirms capture started.
export async function markSessionActive(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions SET status='active' WHERE id=$1 AND status='pending'`,
    [sessionId],
  );
}
