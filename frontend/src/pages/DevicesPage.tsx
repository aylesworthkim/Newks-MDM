import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Monitor,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Trash2,
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
  // Group is the new first-class organizing entity. Devices that enrolled
  // before the Groups migration may have location_id but no group_id; the
  // table grouping logic falls back to location_id in that case.
  group_id: string | null;
  group_name: string | null;
}

interface Group {
  id: string;
  name: string;
  device_count: number;
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

const UNASSIGNED = '__unassigned__';

interface EditDraft {
  device_name: string;
  // Either an existing group_id, the sentinel "" for Unassigned, or the
  // sentinel "__new__" while the user is typing a new group name inline.
  group_id: string;
  new_group_name: string;
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
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

  // Inline edit state -- only one row at a time.
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({
    device_name: '',
    group_id: '',
    new_group_name: '',
  });
  // Group-header rename: holds the group being renamed (real group_id) and
  // the in-progress name. The Unassigned bucket can't be renamed (it's a
  // synthetic UI grouping for devices without a group_id).
  const [editingGroupKey, setEditingGroupKey] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      // Devices and groups in parallel so the row-edit dropdown has the
      // group list ready by the time someone clicks Edit.
      const [devicesResp, groupsResp] = await Promise.all([
        api<{ devices: Device[] }>('/api/devices'),
        api<{ groups: Group[] }>('/api/groups'),
      ]);
      setDevices(devicesResp.devices);
      setGroups(groupsResp.groups);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load devices');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Reload groups only (cheaper than full reload after group mutations).
  const reloadGroups = useCallback(async () => {
    try {
      const groupsResp = await api<{ groups: Group[] }>('/api/groups');
      setGroups(groupsResp.groups);
    } catch {
      // Non-fatal -- next full reload will catch up.
    }
  }, []);

  // Bucket devices into [groupKey, devices] entries for rendering. Group
  // key is the group_id for assigned devices, UNASSIGNED for the rest.
  // Group display name comes from group_name (new schema) or location_id
  // (legacy devices that pre-date the migration). The Unassigned bucket
  // sorts to the bottom.
  const groupedDevices = useMemo(() => {
    if (!devices) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? devices.filter(
          (d) =>
            d.device_name.toLowerCase().includes(q) ||
            d.serial_number.toLowerCase().includes(q) ||
            (d.group_name ?? d.location_id ?? '').toLowerCase().includes(q),
        )
      : devices;
    const buckets = new Map<string, { name: string; devices: Device[] }>();
    for (const d of filtered) {
      const key = d.group_id ?? UNASSIGNED;
      const name = d.group_name ?? d.location_id ?? 'Unassigned';
      const existing = buckets.get(key);
      if (existing) existing.devices.push(d);
      else buckets.set(key, { name, devices: [d] });
    }
    return Array.from(buckets.entries()).sort(([keyA, a], [keyB, b]) => {
      if (keyA === UNASSIGNED) return 1;
      if (keyB === UNASSIGNED) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [devices, query]);

  const totalShown = groupedDevices?.reduce((sum, [, g]) => sum + g.devices.length, 0) ?? 0;
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
      group_id: d.group_id ?? '',
      new_group_name: '',
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
      // Determine target group_id. If the operator picked "Create new
      // group...", create the group first then patch the device with the
      // new group's id. If they picked "Unassigned" (empty string), send
      // null to clear the device's group.
      let targetGroupId: string | null | undefined = undefined;
      if (editDraft.group_id === '__new__') {
        const name = editDraft.new_group_name.trim();
        if (!name) {
          setEditError('New group name cannot be empty.');
          setSaving(false);
          return;
        }
        try {
          const created = await api<{ group: Group }>('/api/groups', {
            method: 'POST',
            body: JSON.stringify({ name }),
          });
          targetGroupId = created.group.id;
          // Make the new group visible in the dropdown for next edits.
          setGroups((prev) => [...prev, created.group].sort((a, b) =>
            a.name.localeCompare(b.name),
          ));
        } catch (err) {
          setEditError(err instanceof ApiError ? err.message : 'failed to create group');
          setSaving(false);
          return;
        }
      } else if (editDraft.group_id === '') {
        targetGroupId = null;
      } else if (editDraft.group_id !== (original.group_id ?? '')) {
        targetGroupId = editDraft.group_id;
      }

      const body: Partial<{ deviceName: string; groupId: string | null }> = {};
      const newName = editDraft.device_name.trim();
      if (newName !== original.device_name) body.deviceName = newName;
      if (targetGroupId !== undefined && targetGroupId !== (original.group_id ?? null)) {
        body.groupId = targetGroupId;
      }
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
      // Reload groups since the device-count display in the dropdown is
      // now stale for both the source and destination groups.
      reloadGroups();
      cancelRowEdit();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  function startGroupRename(groupKey: string, currentName: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (groupKey === UNASSIGNED) return;
    setEditingDeviceId(null);
    setEditError(null);
    setEditingGroupKey(groupKey);
    setGroupDraft(currentName);
  }

  function cancelGroupRename() {
    setEditingGroupKey(null);
    setEditError(null);
  }

  async function saveGroupRename(groupKey: string, oldName: string) {
    const newName = groupDraft.trim();
    if (!newName) {
      setEditError('Group name cannot be empty.');
      return;
    }
    if (newName === oldName) {
      cancelGroupRename();
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      // Single PATCH /api/groups/:id -- backend handles the rename
      // atomically. All devices in this group automatically see the new
      // name on the next devices fetch.
      await api(`/api/groups/${groupKey}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: newName }),
      });
      // Reload both lists so every device row reflects the new group name.
      await load();
      cancelGroupRename();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'rename failed');
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup(groupKey: string, groupName: string, deviceCount: number) {
    if (groupKey === UNASSIGNED) return;
    const ok = window.confirm(
      `Delete group "${groupName}"? ${deviceCount > 0
        ? `${deviceCount} ${deviceCount === 1 ? 'device' : 'devices'} will become Unassigned.`
        : 'No devices are currently in this group.'}`,
    );
    if (!ok) return;
    setSaving(true);
    setEditError(null);
    try {
      await api(`/api/groups/${groupKey}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'delete failed');
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
              {groupedDevices!.map(([groupKey, bucket]) => (
                <tbody key={groupKey}>
                  <tr className="group-header">
                    <td colSpan={5}>
                      {editingGroupKey === groupKey ? (
                        <span className="row-flex">
                          <input
                            type="text"
                            value={groupDraft}
                            onChange={(e) => setGroupDraft(e.target.value)}
                            disabled={saving}
                            autoFocus
                            style={{ maxWidth: 280 }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveGroupRename(groupKey, bucket.name);
                              if (e.key === 'Escape') cancelGroupRename();
                            }}
                          />
                          <button
                            onClick={() => saveGroupRename(groupKey, bucket.name)}
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
                        </span>
                      ) : (
                        <span className="row-flex">
                          <strong>
                            {groupKey === UNASSIGNED ? 'Unassigned' : bucket.name}
                          </strong>
                          <span className="muted">
                            {bucket.devices.length}{' '}
                            {bucket.devices.length === 1 ? 'device' : 'devices'}
                          </span>
                          {groupKey !== UNASSIGNED && (
                            <span className="row-flex" style={{ marginLeft: 'auto', gap: 4 }}>
                              <button
                                onClick={(e) => startGroupRename(groupKey, bucket.name, e)}
                                className="icon-btn"
                                title="Rename group"
                              >
                                <Pencil size={12} />
                              </button>
                              {isAdmin && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    deleteGroup(groupKey, bucket.name, bucket.devices.length);
                                  }}
                                  className="icon-btn"
                                  title="Delete group (devices become Unassigned)"
                                  style={{ color: 'var(--accent)' }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                  {bucket.devices.map((d) => {
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
                              <select
                                value={editDraft.group_id}
                                onChange={(e) =>
                                  setEditDraft((dr) => ({
                                    ...dr,
                                    group_id: e.target.value,
                                    new_group_name: '',
                                  }))
                                }
                                disabled={saving}
                              >
                                <option value="">Unassigned</option>
                                {groups.map((g) => (
                                  <option key={g.id} value={g.id}>{g.name}</option>
                                ))}
                                <option value="__new__">+ Create new group...</option>
                              </select>
                              {editDraft.group_id === '__new__' && (
                                <input
                                  type="text"
                                  value={editDraft.new_group_name}
                                  onChange={(e) =>
                                    setEditDraft((dr) => ({ ...dr, new_group_name: e.target.value }))
                                  }
                                  disabled={saving}
                                  maxLength={64}
                                  placeholder="New group name"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveRowEdit(d);
                                    if (e.key === 'Escape') cancelRowEdit();
                                  }}
                                />
                              )}
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
  // Which row is expanded showing its full payload/result. Only one open
  // at a time keeps the panel compact.
  const [expandedCmdId, setExpandedCmdId] = useState<string | null>(null);

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
    setExpandedCmdId(null);
    loadHistory();
  }, [loadHistory]);

  // Live polling: if a recent command is still queued or dispatched, re-fetch
  // the history every ~1.5s so the status pill updates without manual refresh.
  // Self-stops once everything resolves OR the command is older than 60s
  // (otherwise a permanently-stuck dispatched command would hammer the API).
  useEffect(() => {
    if (!commands) return;
    const cutoff = Date.now() - 60_000;
    const hasRecentPending = commands.some(
      (c) =>
        (c.status === 'queued' || c.status === 'dispatched') &&
        new Date(c.requested_at).getTime() > cutoff,
    );
    if (!hasRecentPending) return;
    const t = setTimeout(() => {
      loadHistory();
    }, 1500);
    return () => clearTimeout(t);
  }, [commands, loadHistory]);

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
      // alongside the live screen. The &popup=1 flag lets RemoteScreenPage
      // know it should close the window (vs navigate) on End Session --
      // window.opener is null due to noopener, so a URL flag is the
      // reliable signal here.
      //
      // We deliberately don't check window.open's return value: with
      // noopener it returns null in most browsers even on success, so a
      // !popup check would always show a false-positive error. If the
      // user's browser blocks popups they'll see Chrome's own indicator
      // in the URL bar -- nothing for us to surface.
      const url = `/devices/${device.id}/screen?session=${response.sessionId}&popup=1`;
      window.open(
        url,
        `mdm-session-${response.sessionId}`,
        'noopener,noreferrer,width=1200,height=900,resizable=yes,scrollbars=yes',
      );
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

      {/* Expanded-row inline detail. Renders the request payload + result
          JSON for inspection. Diagnostics specifically gets a slightly
          nicer formatted view since installedPackages is a wall of text
          when raw-dumped. */}
      {/* (CommandDetailExpanded component definition is below
          DeviceDetail; this comment is just a placement marker.) */}
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
                <th style={{ width: 18 }}></th>
                <th>When</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {commands.slice(0, 10).map((c) => {
                const expanded = expandedCmdId === c.id;
                return (
                  <Fragment key={c.id}>
                    <tr
                      className="cmd-row"
                      onClick={() => setExpandedCmdId(expanded ? null : c.id)}
                    >
                      <td>
                        {expanded
                          ? <ChevronDown size={12} className="muted" />
                          : <ChevronRight size={12} className="muted" />}
                      </td>
                      <td>{new Date(c.requested_at).toLocaleString()}</td>
                      <td><code>{c.command_type}</code></td>
                      <td>
                        <span className={`cmd-status ${c.status}`}>{c.status}</span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="cmd-detail-row">
                        <td colSpan={4}>
                          <CommandDetailExpanded command={c} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

    </div>
  );
}

// -----------------------------------------------------------------------------
// Expanded command detail. Renders the request payload + result JSON inline.
// FETCH_DIAGNOSTICS gets a slightly nicer formatted view since the raw JSON
// of installedPackages is a wall of text.

function CommandDetailExpanded({ command }: { command: CommandRow }) {
  const payloadHasContent = command.payload && Object.keys(command.payload).length > 0;
  const isDiagnostics = command.command_type === 'FETCH_DIAGNOSTICS' && command.result;

  return (
    <div className="cmd-detail">
      {payloadHasContent && (
        <div className="cmd-detail-block">
          <div className="cmd-detail-label">Request payload</div>
          <pre>{JSON.stringify(command.payload, null, 2)}</pre>
        </div>
      )}

      {command.result && isDiagnostics ? (
        <DiagnosticsResultView result={command.result} />
      ) : command.result ? (
        <div className="cmd-detail-block">
          <div className="cmd-detail-label">Result</div>
          <pre>{JSON.stringify(command.result, null, 2)}</pre>
        </div>
      ) : null}

      <div className="cmd-detail-meta">
        {command.requested_by_username && (
          <span>by {command.requested_by_username}</span>
        )}
        {command.dispatched_at && (
          <span>dispatched {new Date(command.dispatched_at).toLocaleTimeString()}</span>
        )}
        {command.completed_at && (
          <span>completed {new Date(command.completed_at).toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  );
}

// Friendlier rendering for FETCH_DIAGNOSTICS specifically. Pulls out the
// well-known keys we send from the agent and shows the installed-packages
// list in a scrollable box. Falls back to raw JSON for anything unexpected.
function DiagnosticsResultView({ result }: { result: Record<string, unknown> }) {
  const known: Array<[string, string]> = [];
  const push = (label: string, val: unknown) => {
    if (val === undefined || val === null) return;
    known.push([label, String(val)]);
  };

  push('Manufacturer', result.manufacturer);
  push('Model', result.model);
  push('Device', result.device);
  push('Android', result.androidVersion);
  push('SDK', result.sdkInt);
  push('Agent version', result.agentVersion);
  push('Accessibility enabled', result.accessibilityEnabled);

  const battery = result.battery as Record<string, unknown> | undefined;
  if (battery) {
    push(
      'Battery',
      `${battery.levelPercent}%${battery.isCharging ? ' (charging)' : ''}`,
    );
  }
  const storage = result.storage as Record<string, unknown> | undefined;
  if (storage) {
    const free = typeof storage.freeBytes === 'number' ? storage.freeBytes : -1;
    const total = typeof storage.totalBytes === 'number' ? storage.totalBytes : -1;
    if (free >= 0 && total >= 0) {
      push('Storage', `${fmtGB(free)} free of ${fmtGB(total)}`);
    }
  }
  const network = result.network as Record<string, unknown> | undefined;
  if (network) {
    push(
      'Network',
      network.connected ? String(network.transport) : 'disconnected',
    );
  }
  const freeMem = result.freeMemBytes as number | undefined;
  const maxMem = result.maxMemBytes as number | undefined;
  if (typeof freeMem === 'number' && typeof maxMem === 'number') {
    push('Memory (process)', `${fmtMB(freeMem)} free of ${fmtMB(maxMem)} max`);
  }

  const pkgs = Array.isArray(result.installedPackages)
    ? (result.installedPackages as string[])
    : [];

  return (
    <div className="cmd-detail-block">
      <div className="cmd-detail-label">Diagnostics</div>
      <dl className="diag-dl">
        {known.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      {pkgs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="cmd-detail-label" style={{ fontSize: 11 }}>
            Installed apps ({pkgs.length})
          </div>
          <div className="diag-pkgs">
            {pkgs.map((p) => <code key={p}>{p}</code>)}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtMB(n: number): string {
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}
function fmtGB(n: number): string {
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
