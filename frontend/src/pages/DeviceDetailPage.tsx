import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Monitor, RefreshCw, Send } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

// Shape of GET /api/devices/:id
interface Device {
  id: string;
  serial_number: string;
  device_name: string;
  model: string | null;
  android_version: string | null;
  location_id: string | null;
  agent_version: string | null;
  status: 'enrolled' | 'online' | 'offline' | 'retired';
  enrolled_at: string;
  last_heartbeat_at: string | null;
}

// Shape of GET /api/devices/:id/commands
interface CommandRow {
  id: string;
  command_type:
    | 'PING'
    | 'FETCH_DIAGNOSTICS'
    | 'OPEN_APP'
    | 'RESTART_APP'
    | 'CHECK_FOR_UPDATE';
  payload: Record<string, unknown>;
  status: 'queued' | 'dispatched' | 'completed' | 'failed' | 'expired';
  requested_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  requested_by_username: string | null;
}

type CommandType = CommandRow['command_type'];

const COMMAND_TYPES: CommandType[] = [
  'PING',
  'FETCH_DIAGNOSTICS',
  'OPEN_APP',
  'RESTART_APP',
  'CHECK_FOR_UPDATE',
];

export function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [device, setDevice] = useState<Device | null>(null);
  const [commands, setCommands] = useState<CommandRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Form state for issuing a new command.
  const [commandType, setCommandType] = useState<CommandType>('PING');
  const [packageName, setPackageName] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  // Remote-session start.
  const [startingSession, setStartingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const canIssueCommands = user?.role === 'admin' || user?.role === 'support';
  const canStartSession = user?.role === 'admin' || user?.role === 'support';
  const needsPackage = commandType === 'OPEN_APP' || commandType === 'RESTART_APP';

  const load = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    setLoadError(null);
    try {
      // Two reads in parallel -- device detail and command history.
      const [deviceResp, commandsResp] = await Promise.all([
        api<{ device: Device }>(`/api/devices/${id}`),
        api<{ commands: CommandRow[] }>(`/api/devices/${id}/commands`),
      ]);
      setDevice(deviceResp.device);
      setCommands(commandsResp.commands);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'failed to load device');
    } finally {
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function startSession() {
    if (!id) return;
    setSessionError(null);
    setStartingSession(true);
    try {
      const response = await api<{ sessionId: string; deviceOnline: boolean }>(
        `/api/devices/${id}/sessions`,
        { method: 'POST' },
      );
      if (!response.deviceOnline) {
        setSessionError('Device is offline; the request is queued but the screen view may stay blank until the device reconnects.');
      }
      navigate(`/devices/${id}/screen?session=${response.sessionId}`);
    } catch (err) {
      setSessionError(err instanceof ApiError ? err.message : 'failed to start session');
    } finally {
      setStartingSession(false);
    }
  }

  async function issueCommand(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    setIssueError(null);
    setIssuing(true);
    try {
      const body = {
        commandType,
        payload: needsPackage ? { package: packageName.trim() } : {},
      };
      await api(`/api/devices/${id}/commands`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Clear the package field after a successful issue so we don't
      // accidentally double-send the same payload.
      setPackageName('');
      await load();
    } catch (err) {
      setIssueError(err instanceof ApiError ? err.message : 'failed to issue command');
    } finally {
      setIssuing(false);
    }
  }

  const enrolledAtPretty = useMemo(
    () => (device ? new Date(device.enrolled_at).toLocaleString() : '-'),
    [device],
  );

  if (loadError && !device) {
    return (
      <div className="card">
        <Link to="/devices" className="row-flex" style={{ marginBottom: 12 }}>
          <ArrowLeft size={14} /> Back to devices
        </Link>
        <div className="error-text">{loadError}</div>
      </div>
    );
  }

  if (!device) {
    return <div className="card muted">Loading...</div>;
  }

  return (
    <>
      <Link to="/devices" className="row-flex" style={{ marginBottom: 12 }}>
        <ArrowLeft size={14} /> Back to devices
      </Link>

      <div className="card">
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{device.device_name}</h2>
          <span className={`status-pill ${device.status}`} style={{ marginLeft: 8 }}>
            {device.status}
          </span>
          <button
            onClick={load}
            disabled={refreshing}
            className="row-flex"
            style={{ marginLeft: 'auto' }}
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            Refresh
          </button>
        </div>

        <DefinitionList
          rows={[
            ['Serial number', device.serial_number],
            ['Location', device.location_id ?? '-'],
            ['Model', device.model ?? '-'],
            ['Android version', device.android_version ?? '-'],
            ['Agent version', device.agent_version ?? '-'],
            ['Enrolled at', enrolledAtPretty],
            [
              'Last heartbeat',
              device.last_heartbeat_at
                ? new Date(device.last_heartbeat_at).toLocaleString()
                : 'never',
            ],
          ]}
        />
      </div>

      {canStartSession && (
        <div className="card">
          <h2>Remote screen</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Start a live remote viewing session. The user at the device will
            need to tap "Start now" on Android's consent dialog before
            sharing begins. Every session is audit-logged.
          </p>
          <button
            type="button"
            className="primary row-flex"
            onClick={startSession}
            disabled={startingSession || device.status !== 'online'}
          >
            <Monitor size={14} />
            {startingSession ? 'Starting...' : 'Start remote session'}
          </button>
          {device.status !== 'online' && (
            <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
              Device must be online to start a session. Current status: {device.status}.
            </p>
          )}
          {sessionError && <div className="error-text">{sessionError}</div>}
        </div>
      )}

      {canIssueCommands && (
        <div className="card">
          <h2>Send command</h2>
          <form onSubmit={issueCommand}>
            <div className="field">
              <label htmlFor="commandType">Command</label>
              <select
                id="commandType"
                value={commandType}
                onChange={(e) => setCommandType(e.target.value as CommandType)}
              >
                {COMMAND_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            {needsPackage && (
              <div className="field">
                <label htmlFor="packageName">Package name</label>
                <input
                  id="packageName"
                  value={packageName}
                  onChange={(e) => setPackageName(e.target.value)}
                  placeholder="com.newks.pos"
                  required
                />
              </div>
            )}
            <button
              type="submit"
              className="primary row-flex"
              disabled={issuing || (needsPackage && !packageName.trim())}
            >
              <Send size={14} />
              {issuing ? 'Sending...' : 'Send command'}
            </button>
            {issueError && <div className="error-text">{issueError}</div>}
          </form>
        </div>
      )}

      <div className="card">
        <h2>Command history</h2>
        {commands === null ? (
          <div className="muted">Loading...</div>
        ) : commands.length === 0 ? (
          <div className="muted" style={{ padding: '8px 0' }}>
            No commands have been sent to this device yet.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Payload</th>
                <th>Status</th>
                <th>By</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.requested_at).toLocaleString()}</td>
                  <td><code>{c.command_type}</code></td>
                  <td>
                    {Object.keys(c.payload).length === 0
                      ? <span className="muted">-</span>
                      : <code>{JSON.stringify(c.payload)}</code>}
                  </td>
                  <td>{c.status}</td>
                  <td>{c.requested_by_username ?? <span className="muted">deleted user</span>}</td>
                  <td>
                    {c.completed_at
                      ? new Date(c.completed_at).toLocaleString()
                      : <span className="muted">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function DefinitionList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '8px 16px', margin: 0 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt className="muted" style={{ fontWeight: 500 }}>{label}</dt>
          <dd style={{ margin: 0 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
