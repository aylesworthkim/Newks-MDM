import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Check, FolderPlus, Pencil, RefreshCw, Trash2, X } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Group {
  id: string;
  name: string;
  created_at: string;
  device_count: number;
}

export function GroupsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canEdit = user?.role === 'admin' || user?.role === 'support';
  const canDelete = user?.role === 'admin';

  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await api<{ groups: Group[] }>('/api/groups');
      setGroups(response.groups);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load groups');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createGroup(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreateBusy(true);
    try {
      await api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      setNewName('');
      setCreating(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'failed to create group');
    } finally {
      setCreateBusy(false);
    }
  }

  function startEdit(g: Group) {
    setEditingId(g.id);
    setEditDraft(g.name);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
  }

  async function saveEdit(g: Group) {
    const name = editDraft.trim();
    if (!name) {
      setError('Group name cannot be empty.');
      return;
    }
    if (name === g.name) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      await api(`/api/groups/${g.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      await load();
      cancelEdit();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'rename failed');
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup(g: Group) {
    const ok = window.confirm(
      `Delete group "${g.name}"? ${g.device_count > 0
        ? `${g.device_count} ${g.device_count === 1 ? 'device' : 'devices'} will become Unassigned.`
        : 'This group has no devices.'}`,
    );
    if (!ok) return;
    setSaving(true);
    try {
      await api(`/api/groups/${g.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'delete failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="devices-layout">
      <section className="devices-list-pane">
        <div className="page-header">
          <h2>Groups</h2>
          {canEdit && (
            <button
              onClick={() => { setCreating((v) => !v); setCreateError(null); }}
              className="primary row-flex"
              style={{ marginRight: 8 }}
            >
              <FolderPlus size={14} />
              {creating ? 'Cancel' : 'New group'}
            </button>
          )}
          <button onClick={load} disabled={refreshing} className="row-flex">
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            Refresh
          </button>
        </div>

        {error && <div className="error-text">{error}</div>}

        {creating && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>New group</h3>
            <form onSubmit={createGroup}>
              <div className="field">
                <label htmlFor="newGroupName">Name</label>
                <input
                  id="newGroupName"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                  autoFocus
                  maxLength={64}
                  placeholder="e.g. 1003 or 1003 - Cedar Park"
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Tip: pre-create groups for every store before deploying tablets.
                  Tablets that enroll with a matching <code>locationId</code> will
                  auto-join the existing group instead of creating duplicates.
                </div>
              </div>
              <button type="submit" className="primary" disabled={createBusy}>
                {createBusy ? 'Creating...' : 'Create group'}
              </button>
              {createError && <div className="error-text">{createError}</div>}
            </form>
          </div>
        )}

        {groups === null ? (
          <div className="muted">Loading...</div>
        ) : groups.length === 0 ? (
          <div className="muted" style={{ padding: '16px 0' }}>
            No groups yet.{canEdit ? ' Click "New group" to add your first one.' : ''}
          </div>
        ) : (
          <div className="devices-table-wrap">
            <table className="devices-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 110 }}>Devices</th>
                  <th>Created</th>
                  <th style={{ width: 100 }}></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const isEditing = editingId === g.id;
                  return (
                    <tr key={g.id} className="device-row">
                      <td>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            disabled={saving}
                            maxLength={64}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit(g);
                              if (e.key === 'Escape') cancelEdit();
                            }}
                          />
                        ) : (
                          <strong>{g.name}</strong>
                        )}
                      </td>
                      <td>
                        {g.device_count > 0 ? (
                          <button
                            onClick={() => navigate(`/devices?group=${g.id}`)}
                            className="link-btn"
                            title="View devices in this group"
                          >
                            {g.device_count} {g.device_count === 1 ? 'device' : 'devices'}
                          </button>
                        ) : (
                          <span className="muted">0 devices</span>
                        )}
                      </td>
                      <td>{new Date(g.created_at).toLocaleString()}</td>
                      <td>
                        {isEditing ? (
                          <span className="row-flex">
                            <button
                              onClick={() => saveEdit(g)}
                              disabled={saving}
                              className="icon-btn"
                              title="Save"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              onClick={cancelEdit}
                              disabled={saving}
                              className="icon-btn"
                              title="Cancel"
                            >
                              <X size={14} />
                            </button>
                          </span>
                        ) : (
                          canEdit && (
                            <span className="row-flex">
                              <button
                                onClick={() => startEdit(g)}
                                className="icon-btn"
                                title="Rename"
                              >
                                <Pencil size={14} />
                              </button>
                              {canDelete && (
                                <button
                                  onClick={() => deleteGroup(g)}
                                  className="icon-btn"
                                  title="Delete group"
                                  style={{ color: 'var(--accent)' }}
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </span>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <aside className="device-detail-pane">
        <div className="detail-empty">
          <Building2 size={32} className="muted" />
          <h3>Groups (stores)</h3>
          <p className="muted">
            Groups organize devices by store or any other bucket. Create them
            ahead of time so tablets land in the right place as they enroll,
            or create them on the fly when assigning devices.
          </p>
        </div>
      </aside>
    </div>
  );
}
