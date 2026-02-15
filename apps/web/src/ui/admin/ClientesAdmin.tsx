import { useEffect, useState } from 'react';
import { apiJson } from '../../api/client';
import type { Device, Tenant } from '../../types';

export function ClientesAdmin({
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
  const [pingPhoneByDevice, setPingPhoneByDevice] = useState<Record<string, string>>({});
  const [pingLoadingDeviceId, setPingLoadingDeviceId] = useState<string | null>(null);

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
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo eliminar el cliente'}`);
    }
  };

  const handleReconnect = async (device: Device) => {
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}/connect`, token, { method: 'POST' });
      const d = await apiJson<Device>(`/devices/${device.id}/status`, token);
      setDevices((prev) => prev.map((x) => (x.id === d.id ? { ...d, label: d.label || x.label } : x)));
      setMsg(`Conectando "${device.label}" — escanea el QR en la pestaña Devices si hace falta.`);
    } catch (err: unknown) {
      setMsg(`Error al reconectar: ${err instanceof Error ? err.message : 'Error desconocido'}`);
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
    } catch (err: unknown) {
      setMsg(`Error al cerrar sesión: ${err instanceof Error ? err.message : 'Error desconocido'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  const handleResetSession = async (device: Device) => {
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}/disconnect`, token, { method: 'POST' });
      await apiJson(`/devices/${device.id}/reset-session`, token, { method: 'POST' });
      setMsg(`Sesión reiniciada en "${device.label}". Ve a Dispositivos y pulsa Conectar para nuevo QR.`);
      const list = await apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(tenantIdOverride)}`, token);
      setDevices(list.map((x) => ({ ...x, label: x.label || x.id || 'Device sin nombre' })));
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo reiniciar sesión'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  const handleResetSenderSessions = async (device: Device) => {
    setDeviceActionLoading(device.id);
    try {
      const res = await apiJson<{ ok: boolean; clearedCount: number }>(
        `/devices/${device.id}/reset-sender-sessions`,
        token,
        { method: 'POST' }
      );
      setMsg(
        res.clearedCount > 0
          ? `Sesiones de ${res.clearedCount} contacto(s) reiniciadas. Si tenían "No matching sessions", que reenvíen el mensaje.`
          : 'Listo. No había contactos recientes para reiniciar.'
      );
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudieron reiniciar sesiones por contacto'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  const handleDeleteDevice = async (device: Device) => {
    const isConnected = device.status === 'ONLINE' || device.status === 'QR';
    const warning = isConnected
      ? `El dispositivo "${device.label}" está ${device.status === 'ONLINE' ? 'conectado' : 'mostrando QR'}. Se desconectará antes de eliminarlo.\n\n¿Eliminar este dispositivo?`
      : `¿Eliminar el dispositivo "${device.label}"?`;
    if (!confirm(warning)) return;
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}`, token, { method: 'DELETE' });
      setDevices((prev) => prev.filter((x) => x.id !== device.id));
      setMsg(`Dispositivo "${device.label}" eliminado.`);
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo eliminar'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  const handleCopyPublicLink = async (device: Device) => {
    try {
      const result = await apiJson<{ url: string }>(`/devices/${device.id}/public-link`, token, { method: 'POST' });
      await navigator.clipboard.writeText(result.url);
      setMsg('Link público (QR) copiado al portapapeles.');
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo generar el link'}`);
    }
  };

  const handlePing = async (device: Device) => {
    const phone = (pingPhoneByDevice[device.id] ?? '').trim();
    if (!phone) {
      setMsg('Indica un número de teléfono para enviar el ping.');
      return;
    }
    if (device.status !== 'ONLINE') {
      setMsg('El dispositivo debe estar conectado (ONLINE) para enviar ping.');
      return;
    }
    setPingLoadingDeviceId(device.id);
    setMsg(null);
    try {
      await apiJson(`/devices/${device.id}/messages/test`, token, {
        method: 'POST',
        body: JSON.stringify({ to: phone, text: 'Ping desde sistema' })
      });
      setMsg(`Ping enviado a ${phone} desde "${device.label}".`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'No se pudo enviar';
      setMsg(message === 'device_not_online' ? 'Dispositivo no conectado.' : `Error: ${message}`);
    } finally {
      setPingLoadingDeviceId(null);
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
        <p className="muted">Haz clic en un cliente para ver sus dispositivos (Conectar, Reconectar, Desconectar, Reset connection, Ping, link QR, Eliminar).</p>
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
              {devices.map((d) => {
                const isOfflineOrError = d.status === 'OFFLINE' || d.status === 'ERROR';
                const connectLabel = isOfflineOrError ? 'Reconectar' : 'Conectar';
                return (
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
                    <div className="actions" style={{ margin: 0, flexWrap: 'wrap', gap: '4px' }}>
                      <button
                        type="button"
                        disabled={deviceActionLoading === d.id}
                        onClick={() => handleReconnect(d)}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {deviceActionLoading === d.id ? '...' : connectLabel}
                      </button>
                      <button
                        type="button"
                        disabled={deviceActionLoading === d.id}
                        onClick={() => handleLogout(d)}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        Desconectar
                      </button>
                      <button
                        type="button"
                        disabled={deviceActionLoading === d.id}
                        onClick={() => handleResetSession(d)}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        Reset connection
                      </button>
                      <button
                        type="button"
                        disabled={deviceActionLoading === d.id}
                        onClick={() => handleResetSenderSessions(d)}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        title="Reinicia las sesiones de cifrado de los contactos que te escribieron (útil si ven &quot;No matching sessions&quot;)"
                      >
                        Reset sesiones por contacto
                      </button>
                      {d.status === 'QR' ? (
                        <button
                          type="button"
                          disabled={deviceActionLoading === d.id}
                          onClick={() => handleCopyPublicLink(d)}
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                        >
                          Copiar link QR
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={deviceActionLoading === d.id}
                        onClick={() => handleDeleteDevice(d)}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        Eliminar
                      </button>
                    </div>
                    <div style={{ width: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
                      <input
                        value={pingPhoneByDevice[d.id] ?? ''}
                        onChange={(e) => setPingPhoneByDevice((prev) => ({ ...prev, [d.id]: e.target.value }))}
                        placeholder="521XXXXXXXXXX"
                        style={{ minWidth: 140, padding: '4px 8px', fontSize: '12px' }}
                      />
                      <button
                        type="button"
                        disabled={d.status !== 'ONLINE' || pingLoadingDeviceId === d.id}
                        onClick={() => handlePing(d)}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {pingLoadingDeviceId === d.id ? '...' : 'Enviar ping'}
                      </button>
                      {d.status !== 'ONLINE' && (
                        <span className="muted" style={{ fontSize: '12px' }}>Dispositivo debe estar ONLINE para ping</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
