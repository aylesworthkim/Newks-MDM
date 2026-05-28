// Minimal API client.
//
// - The JWT lives in localStorage so a page refresh keeps the user logged in.
// - All requests use relative URLs; Vite's dev server proxies /api to the
//   backend, so the browser is always same-origin (no CORS to configure).
// - On 401 we clear the token and redirect to /login -- one place that
//   handles "your session expired," so every page doesn't have to.

const TOKEN_KEY = 'mdm.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });

  // If the token is gone or expired, send the user to /login. Don't redirect
  // if we're already there or we'll loop on the login form's own 401s.
  if (res.status === 401) {
    clearToken();
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'unauthorized');
  }

  // Try to parse JSON; some endpoints (like a future 204) may return empty.
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `request failed (${res.status})`);
  }
  return body as T;
}
