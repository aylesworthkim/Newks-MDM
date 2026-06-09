import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2, UserCog, X } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

type Role = 'admin' | 'support' | 'viewer';

interface UserRow {
  id: string;
  username: string;
  role: Role;
  created_at: string;
}

const ROLES: Role[] = ['admin', 'support', 'viewer'];

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full access; manages users, devices, groups, and commands.',
  support: 'Can manage devices, groups, commands, and remote sessions; cannot manage users.',
  viewer: 'Read-only access to devices and command history.',
};

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Create-form state
  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('support');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  // Reset-password modal state
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  // Per-row role-change pending state (to disable the select while saving)
  const [roleBusyId, setRoleBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await api<{ users: UserRow[] }>('/api/users');
      setUsers(response.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load users');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreateBusy(true);
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
          role: newRole,
        }),
      });
      setNewUsername('');
      setNewPassword('');
      setNewRole('support');
      setCreating(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'failed to create user');
    } finally {
      setCreateBusy(false);
    }
  }

  async function changeRole(u: UserRow, newRoleValue: Role) {
    if (newRoleValue === u.role) return;
    setRoleBusyId(u.id);
    try {
      await api(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRoleValue }),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to change role');
    } finally {
      setRoleBusyId(null);
    }
  }

  async function submitResetPassword(e: FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    setResetError(null);
    setResetBusy(true);
    try {
      await api(`/api/users/${resetTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: resetPassword }),
      });
      setResetTarget(null);
      setResetPassword('');
    } catch (err) {
      setResetError(err instanceof ApiError ? err.message : 'failed to reset password');
    } finally {
      setResetBusy(false);
    }
  }

  async function deleteUser(u: UserRow) {
    const ok = window.confirm(
      `Delete user "${u.username}"? They will be signed out and unable to log back in.`,
    );
    if (!ok) return;
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete user');
    }
  }

  return (
    <div className="devices-layout">
      <section className="devices-list-pane">
        <div className="page-header">
          <h2>Users</h2>
          <button
            onClick={() => setCreating((v) => !v)}
            className="primary row-flex"
            style={{ marginRight: 8 }}
          >
            <Plus size={14} />
            {creating ? 'Cancel' : 'Add user'}
          </button>
          <button onClick={load} disabled={refreshing} className="row-flex">
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            Refresh
          </button>
        </div>

        {error && <div className="error-text">{error}</div>}

        {creating && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>New user</h3>
            <form onSubmit={createUser}>
              <div className="field">
                <label htmlFor="newUsername">Username</label>
                <input
                  id="newUsername"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  required
                  autoComplete="off"
                  maxLength={64}
                />
              </div>
              <div className="field">
                <label htmlFor="newPassword">Initial password</label>
                <input
                  id="newPassword"
                  type="text"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Share this securely with the new user. They can sign in with it
                  and you can reset it later.
                </div>
              </div>
              <div className="field">
                <label htmlFor="newRole">Role</label>
                <select
                  id="newRole"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Role)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {ROLE_DESCRIPTIONS[newRole]}
                </div>
              </div>
              <button type="submit" className="primary" disabled={createBusy}>
                {createBusy ? 'Creating...' : 'Create user'}
              </button>
              {createError && <div className="error-text">{createError}</div>}
            </form>
          </div>
        )}

        {users === null ? (
          <div className="muted">Loading...</div>
        ) : users.length === 0 ? (
          <div className="muted">No users yet.</div>
        ) : (
          <div className="devices-table-wrap">
            <table className="devices-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th style={{ width: 160 }}>Role</th>
                  <th>Created</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isMe = me?.id === u.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.username}</strong>
                        {isMe && (
                          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                            (you)
                          </span>
                        )}
                      </td>
                      <td>
                        <select
                          value={u.role}
                          onChange={(e) => changeRole(u, e.target.value as Role)}
                          disabled={roleBusyId === u.id || isMe}
                          title={isMe ? 'Cannot demote yourself' : ROLE_DESCRIPTIONS[u.role]}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                      <td>{new Date(u.created_at).toLocaleString()}</td>
                      <td>
                        <span className="row-flex">
                          <button
                            onClick={() => setResetTarget(u)}
                            className="icon-btn"
                            title="Reset password"
                          >
                            <KeyRound size={14} />
                          </button>
                          <button
                            onClick={() => deleteUser(u)}
                            className="icon-btn"
                            title={isMe ? 'Cannot delete yourself' : 'Delete user'}
                            disabled={isMe}
                            style={{ color: isMe ? undefined : 'var(--accent)' }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </span>
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
          <UserCog size={32} className="muted" />
          <h3>User management</h3>
          <p className="muted">
            Add IT staff accounts and assign them a role. Admins manage
            everything; support runs commands and remote sessions; viewers see
            history without making changes.
          </p>
        </div>
      </aside>

      {/* Reset-password modal */}
      {resetTarget && (
        <div className="modal-backdrop" onClick={() => setResetTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row-flex" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                Reset password for <code>{resetTarget.username}</code>
              </h3>
              <button
                className="icon-btn"
                onClick={() => setResetTarget(null)}
                style={{ marginLeft: 'auto' }}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={submitResetPassword}>
              <div className="field">
                <label htmlFor="resetPwd">New password</label>
                <input
                  id="resetPwd"
                  type="text"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  The user will be able to log in immediately with this password.
                  Their existing session tokens stay valid until they expire (max 8h).
                </div>
              </div>
              <button type="submit" className="primary" disabled={resetBusy}>
                {resetBusy ? 'Saving...' : 'Set new password'}
              </button>
              {resetError && <div className="error-text">{resetError}</div>}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
