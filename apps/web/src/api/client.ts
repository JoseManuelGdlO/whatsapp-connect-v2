export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export type LoginResponse = { token: string; user: { id: string; email: string; role: string; tenantId: string | null } };

export async function apiFetch<T>(path: string, opts: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  headers.set('content-type', 'application/json');
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);

  const res = await fetch(`${API_URL}${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function apiJson<T>(path: string, token: string, opts: RequestInit = {}): Promise<T> {
  return apiFetch<T>(path, { ...opts, token });
}

export async function login(email: string, password: string) {
  return apiFetch<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

