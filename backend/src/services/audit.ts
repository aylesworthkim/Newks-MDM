// Audit-event helper. Every meaningful action goes through this so we have
// a single append-only paper trail in the audit_events table.
//
// Insert failures are LOGGED but do not throw. Reason: we'd rather complete a
// successful login and lose its audit row than 500 the user because the audit
// insert glitched. Critical actions (command issuance, session start) will get
// transactional audit writes later, where atomicity actually matters.

import { query } from '../db/pool';

export interface AuditEvent {
  eventType: string;
  actorUserId?: string | null;
  deviceId?: string | null;
  details?: Record<string, unknown>;
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_events (actor_user_id, device_id, event_type, details)
       VALUES ($1, $2, $3, $4)`,
      [
        event.actorUserId ?? null,
        event.deviceId ?? null,
        event.eventType,
        JSON.stringify(event.details ?? {}),
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record event', event.eventType, err);
  }
}
