import React, { createContext, useContext, useMemo, useState } from 'react';

type AuthState = {
  token: string | null;
  user: { id: string; email: string; role: string; tenantId: string | null } | null;
  setAuth: (token: string, user: AuthState['user']) => void;
  clear: () => void;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [user, setUser] = useState<AuthState['user']>(() => {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  });

  const value = useMemo<AuthState>(
    () => ({
      token,
      user,
      setAuth: (t, u) => {
        setToken(t);
        setUser(u);
        localStorage.setItem('token', t);
        localStorage.setItem('user', JSON.stringify(u));
      },
      clear: () => {
        setToken(null);
        setUser(null);
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }),
    [token, user]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('AuthProvider missing');
  return ctx;
}

