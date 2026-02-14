import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
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
  
  // Clear tenantIdOverride if user is not SUPERADMIN or if user changed
  useEffect(() => {
    if (!user) {
      // User logged out, clear tenantIdOverride
      if (tenantIdOverride) {
        setTenantIdOverride('');
        localStorage.removeItem('tenantId');
      }
      return;
    }
    
    // Non-superadmin users should not have tenantIdOverride
    if (user.role !== 'SUPERADMIN' && tenantIdOverride) {
      setTenantIdOverride('');
      localStorage.removeItem('tenantId');
    }
  }, [user?.id, user?.role, tenantIdOverride]);
  
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
  const [active, setActive] = useState<'clientes' | 'devices' | 'webhooks'>('clientes');

  if (user?.role !== 'SUPERADMIN') return <div className="card">Forbidden</div>;

  return (
    <div className="grid">
      <div className="card">
        <h2>Admin</h2>
        <div className="actions">
          <button onClick={() => setActive('clientes')}>Clientes</button>
          <button onClick={() => setActive('devices')}>Dispositivos</button>
          <button onClick={() => setActive('webhooks')}>Webhooks</button>
        </div>
        <p className="muted">Selecciona un cliente para gestionar sus dispositivos y webhooks.</p>
      </div>
      {active === 'clientes' ? (
        <ClientesAdmin
          token={token!}
          tenantIdOverride={tenantIdOverride}
          setTenantIdOverride={(v) => {
            setTenantIdOverride(v);
            localStorage.setItem('tenantId', v);
          }}
        />
      ) : active === 'devices' ? (
        <DevicesAdmin token={token!} tenantIdOverride={tenantIdOverride} />
      ) : (
        <WebhooksAdmin token={token!} tenantIdOverride={tenantIdOverride} />
      )}
    </div>
  );
}

function ClientesAdmin({
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
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deviceActionLoading, setDeviceActionLoading] = useState<string | null>(null);

  const selectedTenant = tenants.find((t) => t.id === tenantIdOverride);

  useEffect(() => {
    apiJson<Tenant[]>('/tenants', token).then(setTenants).catch((e) => setMsg(e?.message ?? 'error'));
  }, [token]);

  useEffect(() => {
    if (!tenantIdOverride) {
      setDevices([]);
      return;
    }
    setDevicesLoading(true);
    apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(tenantIdOverride)}`, token)
      .then((data) => setDevices(data.map((d) => ({ ...d, label: d.label || d.id || 'Device sin nombre' }))))
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false));
  }, [token, tenantIdOverride]);

  const handleDelete = async (tenantId: string, tenantName: string) => {
    if (!confirm(`¿Estás seguro de eliminar el cliente "${tenantName}"?\n\nEsto eliminará TODOS los dispositivos, webhooks y eventos asociados. Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      await apiJson(`/tenants/${tenantId}`, token, { method: 'DELETE' });
      setTenants((prev) => prev.filter((t) => t.id !== tenantId));
      if (tenantIdOverride === tenantId) {
        setTenantIdOverride('');
        localStorage.removeItem('tenantId');
      }
      setDevices([]);
      setMsg(`Cliente "${tenantName}" eliminado`);
    } catch (err: any) {
      setMsg(`Error: ${err?.message ?? 'No se pudo eliminar el cliente'}`);
    }
  };

  const handleReconnect = async (device: Device) => {
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}/connect`, token, { method: 'POST' });
      const d = await apiJson<Device>(`/devices/${device.id}/status`, token);
      setDevices((prev) => prev.map((x) => (x.id === d.id ? { ...d, label: d.label || x.label } : x)));
      setMsg(`Conectando "${device.label}" — escanea el QR en la pestaña Devices si hace falta.`);
    } catch (err: any) {
      setMsg(`Error al reconectar: ${err?.message ?? 'Error desconocido'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  const handleLogout = async (device: Device) => {
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}/disconnect`, token, { method: 'POST' });
      const d = await apiJson<Device>(`/devices/${device.id}/status`, token);
      setDevices((prev) => prev.map((x) => (x.id === d.id ? { ...d, label: d.label || x.label } : x)));
      setMsg(`Sesión cerrada en "${device.label}".`);
    } catch (err: any) {
      setMsg(`Error al cerrar sesión: ${err?.message ?? 'Error desconocido'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  return (
    <>
      <div className="card">
        <h3>Crear cliente</h3>
        <div className="actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del cliente" />
          <button
            onClick={async () => {
              setMsg(null);
              const t = await apiJson<Tenant>('/tenants', token, { method: 'POST', body: JSON.stringify({ name }) });
              setTenants((prev) => [t, ...prev]);
              setTenantIdOverride(t.id);
              setName('');
              setMsg(`Cliente creado: ${t.id}`);
            }}
          >
            Crear
          </button>
        </div>
        <label>
          Cliente seleccionado (ID) — para Dispositivos y Webhooks
          <input value={tenantIdOverride} onChange={(e) => setTenantIdOverride(e.target.value)} placeholder="ID del cliente..." />
        </label>
        {msg ? <div className="muted">{msg}</div> : null}
      </div>
      <div className="card">
        <h3>Clientes</h3>
        <p className="muted">Haz clic en un cliente para ver sus dispositivos y reconectar o cerrar sesión.</p>
        <div className="list">
          {tenants.map((t) => (
            <div key={t.id} className={`row ${tenantIdOverride === t.id ? 'active' : ''}`} style={{ cursor: 'default' }}>
              <button
                type="button"
                style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() => {
                  setTenantIdOverride(t.id);
                  localStorage.setItem('tenantId', t.id);
                  setMsg(null);
                }}
              >
                <div>
                  <div className="rowTitle">{t.name}</div>
                  <div className="rowMeta">{t.id}</div>
                </div>
                <div className="rowRight">{t.status}</div>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(t.id, t.name);
                }}
                style={{ marginLeft: '8px', padding: '4px 8px', fontSize: '12px' }}
              >
                Eliminar
              </button>
            </div>
          ))}
        </div>
      </div>
      {tenantIdOverride && selectedTenant ? (
        <div className="card">
          <h3>Dispositivos de {selectedTenant.name}</h3>
          {devicesLoading ? (
            <p className="muted">Cargando dispositivos...</p>
          ) : devices.length === 0 ? (
            <p className="muted">Este cliente no tiene dispositivos.</p>
          ) : (
            <div className="list">
              {devices.map((d) => (
                <div key={d.id} className="row" style={{ cursor: 'default', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <div className="rowTitle" style={{ marginBottom: '4px', fontWeight: 600, fontSize: '14px' }}>
                      {d.label || d.id || 'Device sin nombre'}
                    </div>
                    <div className="rowMeta" style={{ fontSize: '12px', color: '#64748b' }}>
                      {d.status}
                      {d.lastError ? ` · ${d.lastError}` : ''}
                    </div>
                  </div>
                  <div className="actions" style={{ margin: 0 }}>
                    <button
                      type="button"
                      disabled={deviceActionLoading === d.id}
                      onClick={() => handleReconnect(d)}
                      style={{ padding: '4px 8px', fontSize: '12px' }}
                    >
                      {deviceActionLoading === d.id ? '...' : 'Reconectar'}
                    </button>
                    <button
                      type="button"
                      disabled={deviceActionLoading === d.id}
                      onClick={() => handleLogout(d)}
                      style={{ padding: '4px 8px', fontSize: '12px' }}
                    >
                      Cerrar sesión
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

function WebhooksAdmin({ token, tenantIdOverride }: { token: string; tenantIdOverride: string }) {
  const [rows, setRows] = useState<WebhookEndpoint[]>([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !tenantIdOverride) {
      setRows([]);
      return;
    }
    apiJson<WebhookEndpoint[]>(`/webhooks?tenantId=${encodeURIComponent(tenantIdOverride)}`, token).then(setRows).catch(() => setRows([]));
  }, [token, tenantIdOverride]);

  return (
    <>
      <div className="card">
        <h3>Webhooks del cliente</h3>
        <p className="muted">Selecciona un cliente en la pestaña Clientes para gestionar sus webhooks.</p>
        {tenantIdOverride ? (
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
                if (!tenantIdOverride) return;
                const body: any = { url, tenantId: tenantIdOverride };
                if (secret) body.secret = secret;
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
        ) : (
          <p className="muted">Selecciona un cliente en la pestaña Clientes.</p>
        )}
      </div>
      <div className="card">
        <h3>Endpoints</h3>
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
                    const r = await apiJson<{ ok: boolean; status: number }>(`/webhooks/${w.id}/test`, token, {
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
                    await apiJson(`/webhooks/${w.id}`, token, { method: 'DELETE' });
                    setRows((prev) => prev.filter((x) => x.id !== w.id));
                  }}
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function DevicesAdmin({ token, tenantIdOverride }: { token: string; tenantIdOverride: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [filterTenantId, setFilterTenantId] = useState<string>(tenantIdOverride);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const loadDevices = async () => {
      if (!filterTenantId) {
        setDevices([]);
        return;
      }
      try {
        const data = await apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(filterTenantId)}`, token);
        setDevices(data.map((d) => ({ ...d, label: d.label || d.id || 'Device sin nombre' })));
      } catch (err: any) {
        setMsg(`Error al cargar dispositivos: ${err?.message ?? 'error'}`);
      }
    };
    loadDevices();
  }, [token, filterTenantId]);

  // Poll selected device status (for QR and status updates)
  useEffect(() => {
    if (!token || !selectedId) {
      setSelectedDevice(null);
      setQrDataUrl(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const d = await apiJson<Device>(`/devices/${selectedId}/status`, token);
        if (!alive) return;
        setSelectedDevice({ ...d, label: d.label || 'Device sin nombre' });
        setDevices((prev) => prev.map((x) => (x.id === d.id ? { ...d, label: d.label || x.label } : x)));
        if (d.qr) {
          const url = await QRCode.toDataURL(d.qr);
          if (alive) setQrDataUrl(url);
        } else {
          setQrDataUrl(null);
        }
      } catch {
        if (alive) setSelectedDevice(null);
      }
    };
    tick();
    const t = setInterval(tick, 1200);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token, selectedId]);

  const handleDelete = async (deviceId: string, deviceLabel: string, deviceStatus: string) => {
    const isConnected = deviceStatus === 'ONLINE' || deviceStatus === 'QR';
    const warning = isConnected
      ? `El dispositivo "${deviceLabel}" está ${deviceStatus === 'ONLINE' ? 'conectado' : 'mostrando QR'}. Se desconectará automáticamente antes de eliminarlo.\n\n¿Estás seguro de eliminar este dispositivo?`
      : `¿Estás seguro de eliminar el dispositivo "${deviceLabel}"?`;
    
    if (!confirm(warning)) {
      return;
    }
    try {
      await apiJson(`/devices/${deviceId}`, token, { method: 'DELETE' });
      setDevices((prev) => prev.filter((d) => d.id !== deviceId));
      if (selectedId === deviceId) {
        setSelectedId(null);
        setSelectedDevice(null);
        setQrDataUrl(null);
      }
      setMsg(`Dispositivo "${deviceLabel}" eliminado`);
    } catch (err: any) {
      setMsg(`Error: ${err?.message ?? 'No se pudo eliminar el dispositivo'}`);
    }
  };

  const handleConnect = async (device: Device) => {
    setConnecting(true);
    try {
      await apiJson(`/devices/${device.id}/connect`, token, { method: 'POST' });
      setSelectedId(device.id);
      setTimeout(async () => {
        try {
          const d = await apiJson<Device>(`/devices/${device.id}/status`, token);
          setDevices((prev) => prev.map((x) => (x.id === d.id ? d : x)));
          if (d.qr) {
            const url = await QRCode.toDataURL(d.qr);
            setQrDataUrl(url);
          }
        } catch {
          // ignore
        }
      }, 500);
    } catch (err: any) {
      setMsg(`Error al conectar: ${err?.message ?? 'Error desconocido'}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (deviceId: string) => {
    try {
      await apiJson(`/devices/${deviceId}/disconnect`, token, { method: 'POST' });
      setQrDataUrl(null);
    } catch (err: any) {
      setMsg(`Error: ${err?.message ?? 'No se pudo desconectar'}`);
    }
  };

  const handleResetSession = async (device: Device) => {
    try {
      await apiJson(`/devices/${device.id}/disconnect`, token, { method: 'POST' });
      await apiJson(`/devices/${device.id}/reset-session`, token, { method: 'POST' });
      setMsg('Sesión reiniciada. Haz clic en Conectar para obtener un nuevo QR.');
      setSelectedId(device.id);
    } catch (err: any) {
      setMsg(`Error: ${err?.message ?? 'No se pudo reiniciar la sesión'}`);
    }
  };

  return (
    <>
      <div className="card">
        <h3>Gestionar Dispositivos</h3>
        <label>
          Cliente (ID) — selecciona en Clientes o pega el ID
          <input
            value={filterTenantId}
            onChange={(e) => setFilterTenantId(e.target.value)}
            placeholder="ID del cliente..."
          />
        </label>
        {filterTenantId ? (
          <div className="actions" style={{ marginTop: 12 }}>
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Nombre del dispositivo"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget.parentElement?.querySelector('button') as HTMLButtonElement)?.click();
                }
              }}
            />
            <button
              onClick={async () => {
                setMsg(null);
                try {
                  const d = await apiJson<Device>('/devices', token, {
                    method: 'POST',
                    body: JSON.stringify({ tenantId: filterTenantId, label: newLabel.trim() || 'Device' })
                  });
                  setDevices((prev) => [{ ...d, label: d.label || 'Device sin nombre' }, ...prev]);
                  setSelectedId(d.id);
                  setNewLabel('');
                  setMsg(`Dispositivo creado: ${d.label || d.id}`);
                } catch (err: any) {
                  setMsg(`Error al crear: ${err?.message ?? 'Error desconocido'}`);
                }
              }}
            >
              Crear dispositivo
            </button>
          </div>
        ) : null}
        {msg ? <div className="muted" style={{ marginTop: 8 }}>{msg}</div> : null}
      </div>
      <div className="card">
        <h3>Dispositivos</h3>
        <div className="list">
          {devices.map((d) => (
            <div key={d.id} className={`row ${selectedId === d.id ? 'active' : ''}`} style={{ cursor: 'default', flexWrap: 'wrap', gap: '8px' }}>
              <button
                type="button"
                style={{ flex: 1, minWidth: 120, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() => setSelectedId(selectedId === d.id ? null : d.id)}
              >
                <div className="rowTitle" style={{ marginBottom: '4px', fontWeight: 600, fontSize: '14px', color: '#000000' }}>
                  {d.label || d.id || 'Device sin nombre'}
                </div>
                <div className="rowMeta" style={{ fontSize: '12px', color: '#64748b' }}>
                  {d.status}
                  {d.lastError ? ` · ${d.lastError}` : ''}
                </div>
              </button>
              <div className="actions" style={{ margin: 0 }}>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => handleConnect(d)}
                  style={{ padding: '4px 8px', fontSize: '12px' }}
                >
                  Conectar
                </button>
                <button
                  type="button"
                  onClick={() => handleDisconnect(d.id)}
                  style={{ padding: '4px 8px', fontSize: '12px' }}
                >
                  Desconectar
                </button>
                <button
                  type="button"
                  onClick={() => handleResetSession(d)}
                  style={{ padding: '4px 8px', fontSize: '12px' }}
                >
                  Reiniciar sesión
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(d.id, d.label, d.status)}
                  style={{ padding: '4px 8px', fontSize: '12px' }}
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))}
          {devices.length === 0 && filterTenantId && (
            <div className="muted" style={{ padding: '12px' }}>
              No hay dispositivos para este tenant. Crea uno arriba.
            </div>
          )}
          {!filterTenantId && (
            <div className="muted" style={{ padding: '12px' }}>
              Ingresa un TenantId para ver y gestionar dispositivos
            </div>
          )}
        </div>
      </div>
      {selectedDevice ? (
        <div className="card">
          <h3>QR y estado: {selectedDevice.label}</h3>
          <div className="actions">
            <button
              type="button"
              disabled={connecting}
              onClick={() => handleConnect(selectedDevice)}
            >
              {connecting ? 'Conectando...' : 'Conectar'}
            </button>
            <button type="button" onClick={() => handleDisconnect(selectedDevice.id)}>
              Desconectar
            </button>
            <button type="button" onClick={() => handleResetSession(selectedDevice)}>
              Reiniciar sesión
            </button>
            {selectedDevice.status === 'QR' ? (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const result = await apiJson<{ url: string }>(`/devices/${selectedDevice.id}/public-link`, token, { method: 'POST' });
                    await navigator.clipboard.writeText(result.url);
                    setMsg('Link público copiado al portapapeles.');
                  } catch (err: any) {
                    setMsg(`Error: ${err?.message ?? 'No se pudo generar el link'}`);
                  }
                }}
              >
                Copiar link público (QR)
              </button>
            ) : null}
          </div>
          <p className="muted">Estado: {selectedDevice.status}{selectedDevice.lastError ? ` · ${selectedDevice.lastError}` : ''}</p>
          {selectedDevice.status === 'QR' && qrDataUrl ? (
            <div style={{ marginTop: 16 }}>
              <img src={qrDataUrl} alt="QR" style={{ width: 260, height: 260, display: 'block' }} />
              <p className="muted" style={{ marginTop: 8 }}>Escanea con WhatsApp para vincular el dispositivo.</p>
            </div>
          ) : null}
          {selectedDevice.status === 'ONLINE' ? (
            <p style={{ color: '#22c55e', marginTop: 8 }}>Dispositivo conectado.</p>
          ) : null}
          {selectedDevice.status === 'ERROR' && selectedDevice.lastError ? (
            <div className="error" style={{ marginTop: 8 }}>
              <strong>Error:</strong> {selectedDevice.lastError}
              <br />
              <small>Prueba &quot;Reiniciar sesión&quot; y luego &quot;Conectar&quot;.</small>
            </div>
          ) : null}
        </div>
      ) : selectedId ? (
        <div className="card">
          <p className="muted">Cargando estado del dispositivo...</p>
        </div>
      ) : null}
    </>
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
  const [connecting, setConnecting] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('ping');
  const [outbound, setOutbound] = useState<OutboundMessage[]>([]);

  useEffect(() => {
    if (!token || !tenantId) return;
    apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(tenantId)}`, token)
      .then((devices) => {
        // Ensure all devices have a label
        const devicesWithLabels = devices.map((d) => ({
          ...d,
          label: d.label || 'Device sin nombre'
        }));
        setDevices(devicesWithLabels);
      })
      .catch(() => {});
  }, [token, tenantId]);

  useEffect(() => {
    if (!token || !tenantId || !selectedId) return;
    let alive = true;

    const tick = async () => {
      try {
        const d = await apiJson<Device>(`/devices/${selectedId}/status`, token);
        if (!alive) return;
        // Preserve label when updating device status to avoid losing it
        setDevices((prev) => prev.map((x) => {
          if (x.id === d.id) {
            // Keep the existing label if the new one is missing or empty
            return { ...d, label: d.label || x.label || 'Device' };
          }
          return x;
        }));

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
          <input 
            value={newLabel} 
            onChange={(e) => setNewLabel(e.target.value)} 
            placeholder="Nuevo device label" 
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const button = e.currentTarget.parentElement?.querySelector('button');
                button?.click();
              }
            }}
          />
          <button
            onClick={async () => {
              if (!token) return;
              if (!tenantId) return alert('tenantId requerido');
              const label = newLabel.trim() || 'Device';
              const body: any = { label };
              if (user?.role === 'SUPERADMIN') body.tenantId = tenantId;
              try {
                const d = await apiJson<Device>('/devices', token, { method: 'POST', body: JSON.stringify(body) });
                setDevices((prev) => [d, ...prev]);
                setSelectedId(d.id);
                setNewLabel('');
              } catch (err: any) {
                alert(`Error al crear dispositivo: ${err?.message ?? 'Error desconocido'}`);
              }
            }}
          >
            Crear
          </button>
        </div>

        <div className="list">
          {devices.map((d) => (
            <div key={d.id} className={`row ${selectedId === d.id ? 'active' : ''}`} style={{ display: 'flex', alignItems: 'center' }}>
              <button
                style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() => setSelectedId(d.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="rowTitle" style={{ marginBottom: '4px', fontWeight: 600, fontSize: '14px', color: '#000000' }}>
                    {d.label || d.id || 'Device sin nombre'}
                  </div>
                  <div className="rowMeta" style={{ fontSize: '12px', color: '#64748b' }}>
                    {d.status}
                    {d.lastError ? ` · ${d.lastError}` : ''}
                  </div>
                </div>
                <div className="rowRight" style={{ marginLeft: '12px' }}>
                  {d.status === 'QR' ? 'QR' : d.status === 'ONLINE' ? 'OK' : ''}
                </div>
              </button>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  const isConnected = d.status === 'ONLINE' || d.status === 'QR';
                  const warning = isConnected
                    ? `El dispositivo "${d.label}" está ${d.status === 'ONLINE' ? 'conectado' : 'mostrando QR'}. Se desconectará automáticamente antes de eliminarlo.\n\n¿Estás seguro de eliminar este dispositivo?`
                    : `¿Estás seguro de eliminar el dispositivo "${d.label}"?`;
                  
                  if (!confirm(warning)) {
                    return;
                  }
                  try {
                    await apiJson(`/devices/${d.id}`, token!, { method: 'DELETE' });
                    setDevices((prev) => prev.filter((x) => x.id !== d.id));
                    if (selectedId === d.id) {
                      setSelectedId(null);
                    }
                  } catch (err: any) {
                    alert(`Error: ${err?.message ?? 'No se pudo eliminar el dispositivo'}`);
                  }
                }}
                style={{ marginLeft: '8px', padding: '4px 8px', fontSize: '12px' }}
              >
                Eliminar
              </button>
            </div>
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
              <button
                disabled={connecting}
                onClick={async () => {
                  if (!token || !selected) return;
                  setConnecting(true);
                  try {
                    await apiJson(`/devices/${selected.id}/connect`, token!, { method: 'POST' });
                    // Force immediate status update
                    setTimeout(async () => {
                      try {
                        const d = await apiJson<Device>(`/devices/${selected.id}/status`, token);
                        setDevices((prev) => prev.map((x) => (x.id === d.id ? d : x)));
                        if (d.qr) {
                          const url = await QRCode.toDataURL(d.qr);
                          setQrDataUrl(url);
                        }
                      } catch {
                        // ignore
                      }
                    }, 500);
                  } catch (err: any) {
                    alert(`Error al conectar: ${err?.message ?? 'Error desconocido'}`);
                  } finally {
                    setConnecting(false);
                  }
                }}
              >
                {connecting ? 'Conectando...' : 'Connect'}
              </button>
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
              {selected.status === 'QR' && (
                <button
                  onClick={async () => {
                    try {
                      const result = await apiJson<{ url: string }>(`/devices/${selected.id}/public-link`, token!, { method: 'POST' });
                      await navigator.clipboard.writeText(result.url);
                      alert('Link público copiado al portapapeles!');
                    } catch (err: any) {
                      alert(`Error: ${err?.message ?? 'No se pudo generar el link'}`);
                    }
                  }}
                >
                  Copiar Link Público
                </button>
              )}
            </div>

            {selected.status === 'QR' && qrDataUrl ? <img src={qrDataUrl} alt="qr" style={{ width: 260, height: 260 }} /> : null}
            {selected.status === 'ERROR' && selected.lastError ? (
              <div className="error">
                <strong>Error:</strong> {selected.lastError}
                <br />
                <small>Intenta hacer "Reset session" y luego "Connect" de nuevo.</small>
              </div>
            ) : selected.lastError ? (
              <div className="error">Error: {selected.lastError}</div>
            ) : null}
            {selected.status === 'OFFLINE' && !selected.lastError && !connecting ? (
              <div className="muted">Estado: OFFLINE. Haz clic en "Connect" para iniciar la conexión.</div>
            ) : null}

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
          {token ? <Link to="/admin">Admin</Link> : null}
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
                    <Link to="/admin">Ir a Admin</Link>
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
                    navigate('/admin');
                  }}
                />
              </div>
            }
          />
          <Route path="/devices" element={token ? <Navigate to="/admin" replace /> : <Navigate to="/login" replace />} />
          <Route path="/webhooks" element={token ? <Navigate to="/admin" replace /> : <Navigate to="/login" replace />} />
          <Route path="/admin" element={token ? <AdminPage /> : <Navigate to="/login" replace />} />
          <Route path="/public/qr/:token" element={<PublicQrPage />} />
        </Routes>
      </main>
    </div>
  );
}

function PublicQrPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<'loading' | 'QR' | 'ONLINE' | 'EXPIRED' | 'NOT_FOUND'>('loading');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string>('');

  useEffect(() => {
    if (!token) {
      setStatus('NOT_FOUND');
      return;
    }

    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/public/qr/${token}`);
        if (!alive) return;
        
        if (!res.ok) {
          if (res.status === 404) {
            setStatus('NOT_FOUND');
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!alive) return;

        setStatus(data.status);
        setDeviceLabel(data.deviceLabel || '');

        if (data.status === 'QR' && data.qr) {
          const url = await QRCode.toDataURL(data.qr);
          if (alive) setQrDataUrl(url);
        } else {
          setQrDataUrl(null);
        }

        // Stop polling if device is online or expired/not found
        if (data.status === 'ONLINE' || data.status === 'EXPIRED' || data.status === 'NOT_FOUND') {
          return;
        }
      } catch (err) {
        if (!alive) return;
        console.error('Error fetching QR status:', err);
      }
    };

    tick();
    const interval = setInterval(tick, 2000);

    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [token]);

  return (
    <div className="card" style={{ maxWidth: '500px', margin: '2rem auto', textAlign: 'center' }}>
      <h2>Sincronizar WhatsApp</h2>
      
      {status === 'loading' && (
        <div>
          <p>Cargando...</p>
        </div>
      )}

      {status === 'QR' && qrDataUrl && (
        <div>
          <p style={{ marginBottom: '1rem' }}>Escanea este código QR con WhatsApp para sincronizar tu dispositivo.</p>
          <img src={qrDataUrl} alt="QR Code" style={{ width: 300, height: 300, margin: '0 auto', display: 'block' }} />
          {deviceLabel && <p className="muted" style={{ marginTop: '1rem' }}>Dispositivo: {deviceLabel}</p>}
        </div>
      )}

      {status === 'ONLINE' && (
        <div>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✓</div>
          <h3 style={{ color: '#22c55e', marginBottom: '1rem' }}>¡WhatsApp sincronizado!</h3>
          <p>Tu WhatsApp se ha sincronizado correctamente. Puedes cerrar esta ventana.</p>
        </div>
      )}

      {status === 'EXPIRED' && (
        <div>
          <p className="error">Este link ha expirado o el dispositivo ya está conectado.</p>
          {deviceLabel && <p className="muted">Dispositivo: {deviceLabel}</p>}
        </div>
      )}

      {status === 'NOT_FOUND' && (
        <div>
          <p className="error">Link no encontrado o inválido.</p>
        </div>
      )}
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

