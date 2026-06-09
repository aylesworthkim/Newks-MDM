import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DevicesPage } from './pages/DevicesPage';
import { GroupsPage } from './pages/GroupsPage';
import { RemoteScreenPage } from './pages/RemoteScreenPage';
import { UsersPage } from './pages/UsersPage';

// Guards every authenticated route. While we're still verifying a stored
// token, render a neutral "Loading..." so we don't flash the login screen
// on top of a valid session.
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="muted" style={{ padding: 24 }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Routes that render INSIDE the Layout (sidebar + main). Wrapped in a child
// <Routes> so the nested router picks up the rest of the URL after the
// "/*" prefix.
function LayoutRoutes() {
  return (
    <RequireAuth>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/devices" replace />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/devices/:id" element={<DevicesPage />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="*" element={<Navigate to="/devices" replace />} />
        </Routes>
      </Layout>
    </RequireAuth>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* The remote-screen view is opened via window.open() into its own
          window/tab. It does NOT wrap in Layout -- no sidebar competing
          with the live screen for space. Order matters: this more-specific
          path must precede the catch-all below. */}
      <Route
        path="/devices/:id/screen"
        element={
          <RequireAuth>
            <div className="chromeless-page">
              <RemoteScreenPage />
            </div>
          </RequireAuth>
        }
      />
      <Route path="/*" element={<LayoutRoutes />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
