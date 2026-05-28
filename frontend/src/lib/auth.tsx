// Auth context. Holds the current user (or null) and exposes login + logout.
//
// On first mount we look for a stored token and verify it by calling
// /api/auth/me. If it's good, we restore the user; if not, we drop the token
// quietly. This is what makes "refresh the page" not log you out.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, clearToken, getToken, setToken } from './api';

export type UserRole = 'admin' | 'support' | 'viewer';

export interface User {
  id: string;
  username: string;
  role: UserRole;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean; // true on first mount while we verify an existing token
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api<{ user: User }>('/api/auth/me')
      .then((response) => setUser(response.user))
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string): Promise<void> {
    const response = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(response.token);
    setUser(response.user);
  }

  function logout(): void {
    clearToken();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
