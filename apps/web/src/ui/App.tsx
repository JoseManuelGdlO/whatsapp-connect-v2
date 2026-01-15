import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';

import { login } from '../api/client';
import { useAuth } from '../state/auth';

type Device = {
  id: string;
  tenantId?: string;
  label: string;
  status: string;
  qr: string | null;
  lastError: string | null;
};

type WebhookEndpoint = {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  enabled: boolean;
  createdAt: string;
};

type OutboundMessage = {
  id: string;
  to: string;
  status: string;
  isTest: boolean;
  providerMessageId: string | null;
  error: string | null;
  createdAt: string;
};

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function apiJson<T>(path: string, token: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

type Tenant = { id: string; name: string; status: string; createdAt: string };

function useTenantId() {
  const { user } = useAuth();
  const [tenantIdOverride, setTenantIdOverride] = useState<string>(() => localStorage.getItem('tenantId') ?? '');
  const tenantId = useMemo(() => {
    if (user?.role === 'SUPERADMIN') return tenantIdOverride || null;
    return user?.tenantId ?? null;
  }, [user, tenantIdOverride]);
  return { tenantId, tenantIdOverride, setTenantIdOverride };
}

function TenantSelector() {
  const { user } = useAuth();
  const { tenantIdOverride, setTenantIdOverride } = useTenantId();
  if (user?.role !== 'SUPERADMIN') return null;
  return (
    <label>
      TenantId
      <input
        value={tenantIdOverride}
        onChange={(e) => {
          setTenantIdOverride(e.target.value);
          localStorage.setItem('tenantId', e.target.value);
        }}
        placeholder="tenantId..."
      />
    </label>
  );
}

function AdminPage() {
  const { token, user } = useAuth();
  const { tenantIdOverride, setTenantIdOverride } = useTenantId();
  const [active, setActive] = useState<'tenants' | 'users'>('tenants');

  if (user?.role !== 'SUPERADMIN') return <div className="card">Forbidden</div>;

  return (
    <div className="grid">
      <div className="card">
        <h2>Admin</h2>
        <div className="actions">
          <button onClick={() => setActive('tenants')}>Tenants</button>
          <button onClick={() => setActive('users')}>Users</button>
        </div>
        <p className="muted">Tip: al crear/seleccionar un tenant, guardamos su TenantId para usarlo en Devices/Webhooks.</p>
      </div>
      {active === 'tenants' ? (
        <TenantsAdmin
          token={token!}
          tenantIdOverride={tenantIdOverride}
          setTenantIdOverride={(v) => {
            setTenantIdOverride(v);
            localStorage.setItem('tenantId', v);
          }}
        />
      ) : (
        <UsersAdmin token={token!} />
      )}
    </div>
  );
}

function TenantsAdmin({
  token,
  tenantIdOverride,
  setTenantIdOverride
}: {
  token: string;
  tenantIdOverride: string;
  setTenantIdOverride: (v: string) => void;
}) {
  const [name, setName] = useState('');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    apiJson<Tenant[]>('/tenants', token).then(setTenants).catch((e) => setMsg(e?.message ?? 'error'));
  }, [token]);

  return (
    <>
      <div className="card">
        <h3>Crear tenant</h3>
        <div className="actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del tenant" />
          <button
            onClick={async () => {
              setMsg(null);
              const t = await apiJson<Tenant>('/tenants', token, { method: 'POST', body: JSON.stringify({ name }) });
              setTenants((prev) => [t, ...prev]);
              setTenantIdOverride(t.id);
              setName('');
              setMsg(`Tenant creado: ${t.id}`);
            }}
          >
            Crear
          </button>
        </div>
        <label>
          TenantId actual (para usar en Devices/Webhooks)
          <input value={tenantIdOverride} onChange={(e) => setTenantIdOverride(e.target.value)} placeholder="tenantId..." />
        </label>
        {msg ? <div className="muted">{msg}</div> : null}
      </div>
      <div className="card">
        <h3>Tenants</h3>
        <div className="list">
          {tenants.map((t) => (
            <button
              key={t.id}
              className={`row ${tenantIdOverride === t.id ? 'active' : ''}`}
              onClick={() => {
                setTenantIdOverride(t.id);
                setMsg(`Tenant seleccionado: ${t.id}`);
              }}
            >
              <div>
                <div className="rowTitle">{t.name}</div>
                <div className="rowMeta">{t.id}</div>
              </div>
              <div className="rowRight">{t.status}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function UsersAdmin({ token }: { token: string }) {
  const { tenantIdOverride } = useTenantId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('12345678');
  const [role, setRole] = useState<'TENANT_ADMIN' | 'AGENT'>('TENANT_ADMIN');
  const [tenantId, setTenantId] = useState(() => tenantIdOverride);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setTenantId(tenantIdOverride);
  }, [tenantIdOverride]);

  return (
    <div className="card">
      <h3>Crear usuario</h3>
      <p className="muted">Esto llama `POST /users`. Para SUPERADMIN puedes crear usuarios en cualquier tenant.</p>
      <div className="form">
        <label>
          TenantId
          <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenantId..." />
        </label>
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@cliente.com" />
        </label>
        <label>
          Password (min 8)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as any)}>
            <option value="TENANT_ADMIN">TENANT_ADMIN</option>
            <option value="AGENT">AGENT</option>
          </select>
        </label>
        <button
          onClick={async () => {
            setMsg(null);
            const created = await apiJson<any>('/users', token, {
              method: 'POST',
              body: JSON.stringify({ email, password, role, tenantId: tenantId || null })
            });
            setMsg(`Usuario creado: ${created.email} (role=${created.role})`);
            setEmail('');
          }}
        >
          Crear usuario
        </button>
        {msg ? <div className="muted">{msg}</div> : null}
      </div>
    </div>
  );
}

function DevicesPage() {
  const { token, user } = useAuth();
  const { tenantId } = useTenantId();

  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => devices.find((d) => d.id === selectedId) ?? null, [devices, selectedId]);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');

  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('ping');
  const [outbound, setOutbound] = useState<OutboundMessage[]>([]);

  useEffect(() => {
    if (!token || !tenantId) return;
    apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(tenantId)}`, token).then(setDevices).catch(() => {});
  }, [token, tenantId]);

  useEffect(() => {
    if (!token || !tenantId || !selectedId) return;
    let alive = true;

    const tick = async () => {
      try {
        const d = await apiJson<Device>(`/devices/${selectedId}/status`, token);
        if (!alive) return;
        setDevices((prev) => prev.map((x) => (x.id === d.id ? d : x)));

        if (d.qr) {
          const url = await QRCode.toDataURL(d.qr);
          if (alive) setQrDataUrl(url);
        } else {
          setQrDataUrl(null);
        }

        const out = await apiJson<OutboundMessage[]>(`/devices/${selectedId}/messages/outbound`, token);
        if (alive) setOutbound(out);
      } catch {
        // ignore
      }
    };

    tick();
    const t = setInterval(tick, 1200);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token, tenantId, selectedId]);

  return (
    <div className="grid">
      <div className="card">
        <h2>Devices</h2>
        <p className="muted">Selecciona un device y conecta por QR.</p>

        <TenantSelector />

        <div className="actions" style={{ marginTop: 12 }}>
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Nuevo device label" />
          <button
            onClick={async () => {
              if (!token) return;
              if (!tenantId) return alert('tenantId requerido');
              const body: any = { label: newLabel || 'Device' };
              if (user?.role === 'SUPERADMIN') body.tenantId = tenantId;
              const d = await apiJson<Device>('/devices', token, { method: 'POST', body: JSON.stringify(body) });
              setDevices((prev) => [d, ...prev]);
              setSelectedId(d.id);
              setNewLabel('');
            }}
          >
            Crear
          </button>
        </div>

        <div className="list">
          {devices.map((d) => (
            <button key={d.id} className={`row ${selectedId === d.id ? 'active' : ''}`} onClick={() => setSelectedId(d.id)}>
              <div>
                <div className="rowTitle">{d.label}</div>
                <div className="rowMeta">
                  {d.status}
                  {d.lastError ? ` · ${d.lastError}` : ''}
                </div>
              </div>
              <div className="rowRight">{d.status === 'QR' ? 'QR' : d.status === 'ONLINE' ? 'OK' : ''}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Conectar</h2>
        {!selected ? (
          <p className="muted">Selecciona un device.</p>
        ) : (
          <>
            <div className="actions">
              <button onClick={async () => apiJson(`/devices/${selected.id}/connect`, token!, { method: 'POST' })}>Connect</button>
              <button onClick={async () => apiJson(`/devices/${selected.id}/disconnect`, token!, { method: 'POST' })}>
                Disconnect
              </button>
              <button
                onClick={async () => {
                  await apiJson(`/devices/${selected.id}/disconnect`, token!, { method: 'POST' });
                  await apiJson(`/devices/${selected.id}/reset-session`, token!, { method: 'POST' });
                  alert('Session reset. Ahora vuelve a Connect para un QR nuevo.');
                }}
              >
                Reset session
              </button>
            </div>

            {selected.status === 'QR' && qrDataUrl ? <img src={qrDataUrl} alt="qr" style={{ width: 260, height: 260 }} /> : null}
            {selected.lastError ? <div className="error">Error: {selected.lastError}</div> : null}

            <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #e2e8f0' }} />

            <h3>Mensaje de prueba</h3>
            <div className="actions">
              <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="to: 521XXXXXXXXXX" />
              <input value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="texto" />
              <button
                onClick={async () => {
                  await apiJson(`/devices/${selected.id}/messages/test`, token!, {
                    method: 'POST',
                    body: JSON.stringify({ to: testTo, text: testText })
                  });
                }}
              >
                Enviar
              </button>
            </div>

            <h3 style={{ marginTop: 16 }}>Outbound (últimos)</h3>
            <div className="list">
              {outbound.map((o) => (
                <div key={o.id} className="row" style={{ cursor: 'default' }}>
                  <div>
                    <div className="rowTitle">
                      {o.isTest ? '[TEST] ' : ''}
                      {o.to}
                    </div>
                    <div className="rowMeta">
                      {o.status}
                      {o.error ? ` · ${o.error}` : ''}
                    </div>
                  </div>
                  <div className="rowRight">{o.providerMessageId ? 'sent' : ''}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WebhooksPage() {
  const { token } = useAuth();
  const { tenantId } = useTenantId();

  const [rows, setRows] = useState<WebhookEndpoint[]>([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !tenantId) return;
    apiJson<WebhookEndpoint[]>(`/webhooks?tenantId=${encodeURIComponent(tenantId)}`, token).then(setRows).catch(() => {});
  }, [token, tenantId]);

  return (
    <div className="grid">
      <div className="card">
        <h2>Webhooks</h2>
        <TenantSelector />
        <div className="form" style={{ marginTop: 12 }}>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
          </label>
          <label>
            Secret (opcional)
            <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="auto" />
          </label>
          <button
            onClick={async () => {
              if (!token) return;
              if (!tenantId) return alert('tenantId requerido');
              const body: any = { url };
              if (secret) body.secret = secret;
              body.tenantId = tenantId; // API ignores for non-superadmin; required for superadmin
              const created = await apiJson<WebhookEndpoint>('/webhooks', token, { method: 'POST', body: JSON.stringify(body) });
              setRows((prev) => [created, ...prev]);
              setUrl('');
              setSecret('');
            }}
          >
            Crear Webhook
          </button>
          {msg ? <div className="muted">{msg}</div> : null}
        </div>
      </div>

      <div className="card">
        <h2>Endpoints</h2>
        <div className="list">
          {rows.map((w) => (
            <div key={w.id} className="row" style={{ cursor: 'default' }}>
              <div>
                <div className="rowTitle">{w.url}</div>
                <div className="rowMeta">{w.enabled ? 'enabled' : 'disabled'}</div>
              </div>
              <div className="actions">
                <button
                  onClick={async () => {
                    const r = await apiJson<{ ok: boolean; status: number }>(`/webhooks/${w.id}/test`, token!, {
                      method: 'POST',
                      body: JSON.stringify({})
                    });
                    setMsg(`test: status=${r.status} ok=${r.ok}`);
                  }}
                >
                  Test
                </button>
                <button
                  onClick={async () => {
                    await apiJson(`/webhooks/${w.id}`, token!, { method: 'DELETE' });
                    setRows((prev) => prev.filter((x) => x.id !== w.id));
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { token, user, clear, setAuth } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="container">
      <header className="header">
        <div className="brand">WhatsApp Connect v2</div>
        <nav className="nav">
          <Link to="/">Home</Link>
          <Link to="/login">Login</Link>
          {token ? <Link to="/devices">Devices</Link> : null}
          {token ? <Link to="/webhooks">Webhooks</Link> : null}
          {token && user?.role === 'SUPERADMIN' ? <Link to="/admin">Admin</Link> : null}
          {token ? (
            <button className="linkBtn" onClick={() => clear()}>
              Logout
            </button>
          ) : null}
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route
            path="/"
            element={
              <div className="card">
                <h2>Panel</h2>
                {token ? (
                  <div>
                    <p className="muted">Logueado como {user?.email}</p>
                    <Link to="/devices">Ir a Devices</Link>
                  </div>
                ) : (
                  <p>Inicia sesión para comenzar.</p>
                )}
              </div>
            }
          />
          <Route
            path="/login"
            element={
              <div className="card">
                <h2>Login</h2>
                <LoginForm
                  onLogin={async (email, password) => {
                    const r = await login(email, password);
                    setAuth(r.token, r.user);
                    navigate('/devices');
                  }}
                />
              </div>
            }
          />
          <Route path="/devices" element={token ? <DevicesPage /> : <Navigate to="/login" replace />} />
          <Route path="/webhooks" element={token ? <WebhooksPage /> : <Navigate to="/login" replace />} />
          <Route path="/admin" element={token ? <AdminPage /> : <Navigate to="/login" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function LoginForm({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
          await onLogin(email, password);
        } catch (err: any) {
          setError(err?.message ?? 'Login failed');
        } finally {
          setLoading(false);
        }
      }}
    >
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
      </label>
      <button disabled={loading}>{loading ? '...' : 'Login'}</button>
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}

