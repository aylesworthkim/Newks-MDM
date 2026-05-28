// Device-side WebSocket server. Mounted at /ws. Devices connect, register
// themselves, heartbeat, and exchange commands + remote-screen messages.
//
// Browser-side session WebSocket (/ws/sessions/:id) lives in ws/sessions.ts
// and shares the same HTTP server via the upgrade router below.
//
// SECURITY NOTE (MVP gap): a connecting client only needs to know a valid
// deviceId to impersonate that device. Treat this as private-network or
// USB-tethered only for now. Production needs per-device tokens issued at
// enroll time and required in REGISTER_SOCKET. See memory:
// project_production_target.md.

import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

import { query } from '../db/pool';
import { recordAudit } from '../services/audit';
import {
  attachSessionWebSocketServer,
  broadcastToBrowsers,
  finalizeSession,
  getSession,
  markSessionActive,
} from './sessions';

const deviceSockets = new Map<string, WebSocket>();

interface SocketState {
  deviceId: string | null;
}

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('REGISTER_SOCKET'), deviceId: z.string().uuid() }),
  z.object({
    type: z.literal('HEARTBEAT'),
    // Readiness flags the agent attaches to every heartbeat so the portal
    // can show whether the tablet is actually usable for unattended remote
    // access. Both default false if absent (older agents pre-v0.4.0).
    consentArmed: z.boolean().optional(),
    accessibilityEnabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('COMMAND_RESULT'),
    commandId: z.string().uuid(),
    ok: z.boolean(),
    result: z.record(z.unknown()).optional(),
  }),
  // Remote-screen session messages from the device.
  z.object({
    type: z.literal('SESSION_STARTED'),
    sessionId: z.string().uuid(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('SESSION_DENIED'),
    sessionId: z.string().uuid(),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('SESSION_STOPPED'),
    sessionId: z.string().uuid(),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('SESSION_FRAME'),
    sessionId: z.string().uuid(),
    // Base64-encoded JPEG. Size bounded loosely to keep the parser sane;
    // ~512KB of base64 is ~384KB of binary which is enough for a
    // downscaled 1080p frame.
    jpegBase64: z.string().max(700_000),
    ts: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('INPUT_RESULT'),
    sessionId: z.string().uuid(),
    ok: z.boolean(),
    reason: z.string().max(256).optional(),
  }),
]);

// Public: send a JSON payload to a connected device. Used by the commands
// route to dispatch and by the sessions modules to forward messages.
// Returns true if a socket was open; false if the device is offline.
export function sendToDevice(deviceId: string, payload: string): boolean {
  const ws = deviceSockets.get(deviceId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(payload);
  return true;
}

export function attachWebSocketServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  // Routing: /ws -> device handler (here), /ws/sessions/:id -> browser
  // handler (in ws/sessions.ts). Each module registers its own upgrade
  // listener and ignores requests that don't match its prefix.
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') return; // session paths handled by ws/sessions.ts
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Browser-side WS handler shares the same HTTP server but listens for the
  // /ws/sessions/* path. It forwards inputs back through sendToDevice.
  attachSessionWebSocketServer(httpServer, (deviceId, payload) => {
    sendToDevice(deviceId, payload);
  });

  wss.on('connection', (ws) => {
    const state: SocketState = { deviceId: null };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = messageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'invalid message' }));
        return;
      }

      try {
        if (msg.type === 'REGISTER_SOCKET') {
          await handleRegister(ws, state, msg.deviceId);
        } else if (msg.type === 'HEARTBEAT') {
          await handleHeartbeat(ws, state, msg.consentArmed, msg.accessibilityEnabled);
        } else if (msg.type === 'COMMAND_RESULT') {
          await handleCommandResult(ws, state, msg.commandId, msg.ok, msg.result);
        } else if (msg.type === 'SESSION_STARTED') {
          await handleSessionStarted(state, msg.sessionId);
        } else if (msg.type === 'SESSION_DENIED') {
          await handleSessionDenied(state, msg.sessionId, msg.reason);
        } else if (msg.type === 'SESSION_STOPPED') {
          await handleSessionStopped(state, msg.sessionId, msg.reason);
        } else if (msg.type === 'SESSION_FRAME') {
          handleSessionFrame(state, msg.sessionId, msg.jpegBase64, msg.ts);
        } else if (msg.type === 'INPUT_RESULT') {
          // Quiet ack; we don't persist these for MVP. If they fail we
          // log so we can see in the backend terminal.
          if (!msg.ok) {
            // eslint-disable-next-line no-console
            console.warn('[ws] input failed', msg.sessionId, msg.reason);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ws] error handling message', msg.type, err);
        ws.send(JSON.stringify({ type: 'ERROR', message: 'internal error' }));
      }
    });

    ws.on('close', async () => {
      if (!state.deviceId) return;
      if (deviceSockets.get(state.deviceId) !== ws) return;
      deviceSockets.delete(state.deviceId);
      try {
        // On disconnect: device is offline AND its readiness flags no longer
        // apply (the MediaProjection token died with the process). The next
        // heartbeat after reconnect will report the new state.
        await query(
          `UPDATE devices SET
              status = 'offline',
              consent_armed = FALSE,
              accessibility_enabled = FALSE
           WHERE id = $1 AND status = 'online'`,
          [state.deviceId],
        );
        await recordAudit({
          deviceId: state.deviceId,
          eventType: 'device.socket.disconnect',
          details: {},
        });
        // Any sessions belonging to this device need to be wound down --
        // a disappearing device can't send SESSION_STOPPED itself.
        const activeSessions = await query<{ id: string }>(
          `SELECT id FROM sessions WHERE device_id=$1 AND status IN ('pending', 'active')`,
          [state.deviceId],
        );
        for (const row of activeSessions.rows) {
          await finalizeSession(row.id, 'device disconnected', 'failed');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ws] error on close cleanup', err);
      }
    });
  });
}

async function handleRegister(ws: WebSocket, state: SocketState, deviceId: string): Promise<void> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM devices WHERE id=$1`,
    [deviceId],
  );
  if (existing.rows.length === 0) {
    ws.send(JSON.stringify({ type: 'ERROR', message: 'unknown device' }));
    ws.close();
    return;
  }

  const prev = deviceSockets.get(deviceId);
  if (prev && prev !== ws) {
    prev.close();
  }

  state.deviceId = deviceId;
  deviceSockets.set(deviceId, ws);

  await query(
    `UPDATE devices SET status='online', last_heartbeat_at=now() WHERE id=$1`,
    [deviceId],
  );
  await recordAudit({ deviceId, eventType: 'device.socket.connect', details: {} });

  ws.send(JSON.stringify({ type: 'WELCOME', deviceId }));
  await dispatchCommandsToDevice(deviceId);
}

async function handleHeartbeat(
  ws: WebSocket,
  state: SocketState,
  consentArmed: boolean | undefined,
  accessibilityEnabled: boolean | undefined,
): Promise<void> {
  if (!state.deviceId) {
    ws.send(JSON.stringify({ type: 'ERROR', message: 'not registered' }));
    return;
  }
  // COALESCE on the readiness flags: if a v0.3.x or older agent connects and
  // doesn't send the field, leave the previous value alone rather than reset
  // to false. Once the agent updates to v0.4.0+, the field arrives and is
  // tracked normally.
  await query(
    `UPDATE devices SET
        last_heartbeat_at = now(),
        status = 'online',
        consent_armed = COALESCE($2, consent_armed),
        accessibility_enabled = COALESCE($3, accessibility_enabled)
     WHERE id = $1`,
    [state.deviceId, consentArmed ?? null, accessibilityEnabled ?? null],
  );
}

async function handleCommandResult(
  ws: WebSocket,
  state: SocketState,
  commandId: string,
  ok: boolean,
  result: Record<string, unknown> | undefined,
): Promise<void> {
  if (!state.deviceId) {
    ws.send(JSON.stringify({ type: 'ERROR', message: 'not registered' }));
    return;
  }
  await query(
    `UPDATE commands
     SET status = $1, completed_at = now(), result = $2
     WHERE id = $3 AND device_id = $4`,
    [ok ? 'completed' : 'failed', JSON.stringify(result ?? {}), commandId, state.deviceId],
  );
  await recordAudit({
    deviceId: state.deviceId,
    eventType: ok ? 'command.complete' : 'command.failed',
    details: { commandId },
  });
}

async function handleSessionStarted(state: SocketState, sessionId: string): Promise<void> {
  if (!state.deviceId) return;
  const session = getSession(sessionId);
  if (!session || session.deviceId !== state.deviceId) return;
  await markSessionActive(sessionId);
  await recordAudit({
    deviceId: state.deviceId,
    eventType: 'session.start.success',
    details: { sessionId },
  });
  // Notify any already-attached browser viewers that capture is live.
  broadcastToBrowsers(sessionId, JSON.stringify({ type: 'SESSION_ACTIVE', sessionId }));
}

async function handleSessionDenied(
  state: SocketState,
  sessionId: string,
  reason: string | undefined,
): Promise<void> {
  if (!state.deviceId) return;
  await recordAudit({
    deviceId: state.deviceId,
    eventType: 'session.start.denied',
    details: { sessionId, reason: reason ?? null },
  });
  await finalizeSession(sessionId, reason ?? 'denied on device', 'failed');
}

async function handleSessionStopped(
  state: SocketState,
  sessionId: string,
  reason: string | undefined,
): Promise<void> {
  if (!state.deviceId) return;
  await finalizeSession(sessionId, reason ?? 'stopped on device', 'ended');
}

function handleSessionFrame(
  state: SocketState,
  sessionId: string,
  jpegBase64: string,
  ts: number | undefined,
): void {
  if (!state.deviceId) return;
  const session = getSession(sessionId);
  if (!session || session.deviceId !== state.deviceId) return;
  // Forward the frame to all browser viewers. We deliberately keep the
  // message format compact -- the frame goes out exactly as the device
  // sent it, no re-encoding.
  broadcastToBrowsers(
    sessionId,
    JSON.stringify({ type: 'SESSION_FRAME', sessionId, jpegBase64, ts: ts ?? Date.now() }),
  );
}

// Called by the commands route after a new command is inserted, AND on
// REGISTER_SOCKET to catch the device up on anything queued while offline.
export async function dispatchCommandsToDevice(deviceId: string): Promise<void> {
  const ws = deviceSockets.get(deviceId);
  if (!ws || ws.readyState !== ws.OPEN) return;

  const queued = await query<{
    id: string;
    command_type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, command_type, payload
     FROM commands
     WHERE device_id = $1 AND status = 'queued'
     ORDER BY requested_at ASC`,
    [deviceId],
  );

  for (const row of queued.rows) {
    ws.send(
      JSON.stringify({
        type: 'COMMAND',
        commandId: row.id,
        commandType: row.command_type,
        payload: row.payload,
      }),
    );
    await query(
      `UPDATE commands SET status='dispatched', dispatched_at=now() WHERE id=$1`,
      [row.id],
    );
  }
}
