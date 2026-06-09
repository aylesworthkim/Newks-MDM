// Top-level shell for authenticated pages. Two-pane layout: fixed-width
// left sidebar (brand + nav + user) and the page-rendered main area to its
// right. Pages that need a "device detail" right panel (currently just
// DevicesPage) own that internally -- keeping it page-scoped avoids
// plumbing device state through the Layout for pages that don't care.

import { Building2, LogOut, Tablet, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand">
          <img src="/newks-logo.png" alt="Newk's Eatery" className="brand-logo" />
          <div className="brand-subtitle">Remote Device Management</div>
        </div>

        <nav className="sidebar-nav">
          <NavLink
            to="/devices"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <Tablet size={16} />
            <span>Devices</span>
          </NavLink>
          <NavLink
            to="/groups"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <Building2 size={16} />
            <span>Groups</span>
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink
              to="/users"
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            >
              <Users size={16} />
              <span>Users</span>
            </NavLink>
          )}
          {/* Future nav slots can go here (Reports, Settings, etc.) */}
        </nav>

        {user && (
          <div className="sidebar-footer">
            <div className="user-block">
              <div className="muted user-label">Signed in as</div>
              <div className="user-name">{user.username}</div>
              <div className="muted user-role">{user.role}</div>
            </div>
            <button
              onClick={logout}
              className="row-flex sidebar-signout"
              aria-label="Sign out"
            >
              <LogOut size={14} />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </aside>

      <main className="app-main">{children}</main>
    </div>
  );
}
