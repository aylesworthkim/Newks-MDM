import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Check,
  Monitor,
  Pencil,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';

import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

// Mirrors the row shape returned by GET /api/devices on the backend.
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
  consent_armed: boolean;
  accessibility_enabled: boolean;
}

// Shape of GET /api/devices/:id/commands
interface CommandRow {
  id: string;
  command_type: 'PING' | 'FETCH_DIAGNOSTICS' | 'OPEN_APP' | 'RESTART_APP';
  payload: Record<string, unknown>;
  status: 'queued' | 'dispatched' | 'completed' | 'failed' | 'expired';
  requested_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  requested_by_username: string | null;
}

type CommandType = CommandRow['command_type'];
const COMMAND_TYPES: CommandType[] = ['PING', 'FETCH_DIAGNOSTICS', 'OPEN_APP', 'RESTART_APP'];

const UNASSIGNED = '__unassigned__';

interface EditDraft {
  device_name: string;
  location_id: string;
}

function readinessFor(d: Device): { label: string; tone: 'ok' | 'warn' | 'off'; tooltip: string } {
  if (d.status !== 'online') {
    return {
      label: 'Offline',
      tone: 'off',
      tooltip: 'Tablet is not currently connected. Readiness will refresh once it reconnects.',
    };
  }
  // v0.5.0+ agent: both consent_armed and accessibility_enabled track the
  // same thing (accessibility service status). Older agents may still
  // report consent_armed independently; treat either being false as
  // "remote support not ready" since both are needed.
  if (!d.accessibility_enabled || !d.consent_armed) {
    return {
      label: 'Needs setup',
      tone: 'warn',
      tooltip:
        'Tablet is online but the agent\'s accessibility service is not enabled. ' +
        'Remote view + control won\'t work until someone taps the notification on ' +
        'the tablet (or goes to Settings → Accessibility → Newk\'s MDM Agent) and ' +
        'turns it on.',
    };
  }
  return {
    label: 'Ready',
    tone: 'ok',
    tooltip: 'Tablet is fully ready for unattended remote access (view + control).',
  };
}

export function DevicesPage() {
  const { id: selectedId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

  // Inline edit state -- only one row at a time.
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ device_name: '', location_id: '' });
  const [editingGroupKey, setEditingGroupKey] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await api<{ devices: Device[] }>('/api/devices');
      setDevices(response.devices);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load devices');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    if (!devices) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? devices.filter(
          (d) =>
            d.device_name.toLowerCase().includes(q) ||
            d.serial_number.toLowerCase().includes(q) ||
            (d.location_id ?? '').toLowerCase().includes(q),
        )
      : devices;
    const byStore = new Map<string, Device[]>();
    for (const d of filtered) {
      const key = d.location_id && d.location_id.trim() !== '' ? d.location_id : UNASSIGNED;
      const list = byStore.get(key) ?? [];
      list.push(d);
      byStore.set(key, list);
    }
    return Array.from(byStore.entries()).sort(([a], [b]) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return a.localeCompare(b);
    });
  }, [devices, query]);

  const totalShown = groups?.reduce((sum, [, list]) => sum + list.length, 0) ?? 0;
  const selectedDevice = useMemo(
    () => devices?.find((d) => d.id === selectedId) ?? null,
    [devices, selectedId],
  );

  function selectDevice(id: string) {
    // Toggle behavior: clicking the already-selected row clears selection.
    if (selectedId === id) {
      navigate('/devices');
    } else {
      navigate(`/devices/${id}`);
    }
  }

  function startRowEdit(d: Device, e: React.MouseEvent) {
    e.stopPropagation(); // don't trigger row-select
    setEditingGroupKey(null);
    setEditError(null);
    setEditingDeviceId(d.id);
    setEditDraft({
      device_name: d.device_name,
      location_id: d.location_id ?? '',
    });
  }

  function cancelRowEdit() {
    setEditingDeviceId(null);
    setEditError(null);
  }

  async function saveRowEdit(original: Device) {
    if (!editDraft.device_name.trim()) {
      setEditError('Device name cannot be empty.');
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const body: Partial<{ deviceName: string; locationId: string }> = {};
      const newName = editDraft.device_name.trim();
      const newLocation = editDraft.location_id.trim();
      if (newName !== original.device_name) body.deviceName = newName;
      if (newLocation !== (original.location_id ?? '')) body.locationId = newLocation;
      if (Object.keys(body).length === 0) {
        cancelRowEdit();
        return;
      }
      const response = await api<{ device: Device }>(`/api/devices/${original.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setDevices((prev) =>
        prev ? prev.map((d) => (d.id === original.id ? response.device : d)) : prev,
      );
      cancelRowEdit();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  function startGroupRename(storeKey: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (storeKey === UNASSIGNED) return;
    setEditingDeviceId(null);
    setEditError(null);
    setEditingGroupKey(storeKey);
    setGroupDraft(storeKey);
  }

  function cancelGroupRename() {
    setEditingGroupKey(null);
    setEditError(null);
  }

  async function saveGroupRename(oldKey: string, devicesInGroup: Device[]) {
    const newKey = groupDraft.trim();
    if (!newKey) {
      setEditError('Store name cannot be empty.');
      return;
    }
    if (newKey === oldKey) {
      cancelGroupRename();
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const updated = await Promise.all(
        devicesInGroup.map((d) =>
          api<{ device: Device }>(`/api/devices/${d.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ locationId: newKey }),
          }),
        ),
      );
      const updatedById = new Map(updated.map((r) => [r.device.id, r.device]));
      setDevices((prev) => (prev ? prev.map((d) => updatedById.get(d.id) ?? d) : prev));
      cancelGroupRename();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'rename failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="devices-layout">
      <section className="devices-list-pane">
        <div className="page-header">
          <h2>Devices</h2>
          <button
            onClick={load}
            disabled={refreshing}
            className="row-flex"
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            Refresh
          </button>
        </div>

        {error && <div className="error-text">{error}</div>}
        {editError && <div className="error-text">{editError}</div>}

        {devices && devices.length > 0 && (
          <div className="search-wrap" style={{ marginBottom: 12 }}>
            <Search size={14} className="search-icon" />
            <input
              type="text"
              placeholder="Search by name, serial, or store..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 32 }}
            />
          </div>
        )}

        {devices === null ? (
          <div className="muted">Loading...</div>
        ) : devices.length === 0 ? (
          <div className="muted" style={{ padding: '16px 0' }}>
            No devices enrolled yet. Devices enroll themselves by POSTing to
            /api/devices/enroll with the enrollment secret.
          </div>
        ) : totalShown === 0 ? (
          <div className="muted" style={{ padding: '16px 0' }}>
            No devices match &quot;{query}&quot;.
          </div>
        ) : (
          <div className="devices-table-wrap">
            <table className="devices-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Last heartbeat</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              {groups!.map(([storeKey, storeDevices]) => (
                <tbody key={storeKey}>
                  <tr className="group-header">
                    <td colSpan={5}>
                      {editingGroupKey === storeKey ? (
                        <span className="row-flex">
                          <input
                            type="text"
                            value={groupDraft}
                            onChange={(e) => setGroupDraft(e.target.value)}
                            disabled={saving}
                            autoFocus
                            style={{ maxWidth: 280 }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveGroupRename(storeKey, storeDevices);
                              if (e.key === 'Escape') cancelGroupRename();
                            }}
                          />
                          <button
                            onClick={() => saveGroupRename(storeKey, storeDevices)}
                            disabled={saving}
                            className="icon-btn"
                            title="Save"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={cancelGroupRename}
                            disabled={saving}
                            className="icon-btn"
                            title="Cancel"
                          >
                            <X size={14} />
                          </button>
                          <span className="muted">
                            renaming will move {storeDevices.length}{' '}
                            {storeDevices.length === 1 ? 'device' : 'devices'}
                          </span>
                        </span>
                      ) : (
                        <span className="row-flex">
                          <strong>
                            {storeKey === UNASSIGNED ? 'Unassigned' : storeKey}
                          </strong>
                          <span className="muted">
                            {storeDevices.length}{' '}
                            {storeDevices.length === 1 ? 'device' : 'devices'}
                          </span>
                          {storeKey !== UNASSIGNED && (
                            <button
                              onClick={(e) => startGroupRename(storeKey, e)}
                              className="icon-btn"
                              title="Rename store (moves all devices in this group)"
                              style={{ marginLeft: 'auto' }}
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                  {storeDevices.map((d) => {
                    const isEditing = editingDeviceId === d.id;
                    const isSelected = selectedId === d.id;
                    return (
                      <tr
                        key={d.id}
                        className={`device-row ${isSelected ? 'selected' : ''}`}
                        onClick={() => !isEditing && selectDevice(d.id)}
                      >
                        <td>
                          {isEditing ? (
                            <div
                              className="edit-stack"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="text"
                                value={editDraft.device_name}
                                onChange={(e) =>
                                  setEditDraft((dr) => ({ ...dr, device_name: e.target.value }))
                                }
                                disabled={saving}
                                autoFocus
                                maxLength={128}
                                placeholder="Device name"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveRowEdit(d);
                                  if (e.key === 'Escape') cancelRowEdit();
                                }}
                              />
                              <input
                                type="text"
                                value={editDraft.location_id}
                                onChange={(e) =>
                                  setEditDraft((dr) => ({ ...dr, location_id: e.target.value }))
                                }
                                disabled={saving}
                                maxLength={64}
                                placeholder="Store id (blank = unassigned)"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveRowEdit(d);
                                  if (e.key === 'Escape') cancelRowEdit();
                                }}
                              />
                            </div>
                          ) : (
                            <span className="device-name-cell">{d.device_name}</span>
                          )}
                        </td>
                        <td>{d.model ?? '-'}</td>
                        <td>
                          <span className="row-flex" style={{ gap: 6 }}>
                            <span className={`status-pill ${d.status}`}>{d.status}</span>
                            {(() => {
                              const r = readinessFor(d);
                              return (
                                <span
                                  className={`readiness-pill ${r.tone}`}
                                  title={r.tooltip}
                                >
                                  {r.label}
                                </span>
                              );
                            })()}
                          </span>
                        </td>
                        <td>
                          {d.last_heartbeat_at
                            ? new Date(d.last_heartbeat_at).toLocaleString()
                            : '-'}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {isEditing ? (
                            <span className="row-flex">
                              <button
                                onClick={() => saveRowEdit(d)}
                                disabled={saving}
                                className="icon-btn"
                                title="Save"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={cancelRowEdit}
                                disabled={saving}
                                className="icon-btn"
                                title="Cancel"
                              >
                                <X size={14} />
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={(e) => startRowEdit(d, e)}
                              className="icon-btn"
                              title="Edit name and store"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </section>

      <aside className="device-detail-pane">
        {selectedDevice ? (
          <DeviceDetail
            device={selectedDevice}
            onCleared={() => navigate('/devices')}
          />
        ) : (
          <div className="detail-empty">
            <Monitor size={32} className="muted" />
            <h3>Select a device</h3>
            <p className="muted">
              Click any tablet on the left to see its details, send commands, or
              start a remote session.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Right-pane device detail. Owns its own command-history load + command-issue
// form. Re-fetches when the parent passes a different `device.id`.

interface DeviceDetailProps {
  device: Device;
  // The list owns the canonical Device array; row-level edits happen on the
  // list itself (pencil icon). If we later add inline edits to this panel we
  // can re-introduce an onChanged callback to push updates upward.
  onCleared: () => void;
}

function DeviceDetail({ device, onCleared }: DeviceDetailProps) {
  const { user } = useAuth();
  const [commands, setCommands] = useState<CommandRow[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [commandType, setCommandType] = useState<CommandType>('PING');
  const [packageName, setPackageName] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [startingSession, setStartingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const canEdit = user?.role === 'admin' || user?.role === 'support';
  const needsPackage = commandType === 'OPEN_APP' || commandType === 'RESTART_APP';

  const loadHistory = useCallback(async () => {
    setHistoryError(null);
    try {
      const response = await api<{ commands: CommandRow[] }>(
        `/api/devices/${device.id}/commands`,
      );
      setCommands(response.commands);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : 'failed to load history');
    }
  }, [device.id]);

  useEffect(() => {
    setCommands(null);
    loadHistory();
  }, [loadHistory]);

  async function startSession() {
    setSessionError(null);
    setStartingSession(true);
    try {
      const response = await api<{ sessionId: string; deviceOnline: boolean }>(
        `/api/devices/${device.id}/sessions`,
        { method: 'POST' },
      );
      if (!response.deviceOnline) {
        setSessionError(
          'Device is offline; the request is queued but the screen view may stay ' +
            'blank until the device reconnects.',
        );
      }
      // Open in a new window so the operator can keep the device list visible
      // alongside the live screen.
      const url = `/devices/${device.id}/screen?session=${response.sessionId}`;
      const popup = window.open(
        url,
        `mdm-session-${response.sessionId}`,
        'noopener,noreferrer,width=1200,height=900,resizable=yes,scrollbars=yes',
      );
      if (!popup) {
        setSessionError(
          'Could not open the session window. Allow popups for this site and try again.',
        );
      }
    } catch (err) {
      setSessionError(err instanceof ApiError ? err.message : 'failed to start session');
    } finally {
      setStartingSession(false);
    }
  }

  async function issueCommand(e: FormEvent) {
    e.preventDefault();
    setIssueError(null);
    setIssuing(true);
    try {
      const body = {
        commandType,
        payload: needsPackage ? { package: packageName.trim() } : {},
      };
      await api(`/api/devices/${device.id}/commands`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setPackageName('');
      await loadHistory();
    } catch (err) {
      setIssueError(err instanceof ApiError ? err.message : 'failed to issue command');
    } finally {
      setIssuing(false);
    }
  }

  const readiness = readinessFor(device);

  return (
    <div className="detail-content">
      <header className="detail-header">
        <div>
          <h3 className="detail-title">{device.device_name}</h3>
          <div className="detail-subtitle muted">
            {device.location_id ?? 'Unassigned'} ·{' '}
            <span className="mono">{device.serial_number}</span>
          </div>
        </div>
        <button
          onClick={onCleared}
          className="icon-btn"
          title="Close detail"
          aria-label="Close detail panel"
        >
          <X size={16} />
        </button>
      </header>

      <div className="detail-status-row">
        <span className={`status-pill ${device.status}`}>{device.status}</span>
        <span className={`readiness-pill ${readiness.tone}`} title={readiness.tooltip}>
          {readiness.label}
        </span>
      </div>

      <dl className="detail-dl">
        <dt>Model</dt>
        <dd>{device.model ?? '-'}</dd>
        <dt>Android</dt>
        <dd>{device.android_version ?? '-'}</dd>
        <dt>Agent</dt>
        <dd>{device.agent_version ?? '-'}</dd>
        <dt>Enrolled</dt>
        <dd>{new Date(device.enrolled_at).toLocaleString()}</dd>
        <dt>Last heartbeat</dt>
        <dd>
          {device.last_heartbeat_at
            ? new Date(device.last_heartbeat_at).toLocaleString()
            : 'never'}
        </dd>
      </dl>

      {canEdit && (
        <section className="detail-section">
          <h4>Remote screen</h4>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {device.consent_armed
              ? 'Tablet has granted screen-share consent. The session will start immediately.'
              : 'Tablet has not granted consent yet. The store manager will see a "Start now" prompt.'}
            {' '}
            {!device.accessibility_enabled && (
              <em>
                Accessibility service is not enabled, so this session will be view-only
                (no remote tap/swipe).
              </em>
            )}
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
              Device must be online to start a session.
            </p>
          )}
          {sessionError && <div className="error-text">{sessionError}</div>}
        </section>
      )}

      {canEdit && (
        <section className="detail-section">
          <h4>Send command</h4>
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
        </section>
      )}

      <section className="detail-section">
        <h4>Recent commands</h4>
        {historyError && <div className="error-text">{historyError}</div>}
        {commands === null ? (
          <div className="muted">Loading...</div>
        ) : commands.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No commands sent yet.
          </div>
        ) : (
          <table className="compact-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {commands.slice(0, 10).map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.requested_at).toLocaleString()}</td>
                  <td><code>{c.command_type}</code></td>
                  <td>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

    </div>
  );
}
