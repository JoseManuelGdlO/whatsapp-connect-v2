import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../../api/client';
import type { Device, Tenant } from '../../types';

function normalizeDevice(d: Device): Device {
  return { ...d, label: d.label || d.id || 'Device sin nombre' };
}

export function AllDevicesAdmin({ token }: { token: string }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [devicesByTenant, setDevicesByTenant] = useState<Record<string, Device[]>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [deviceActionLoading, setDeviceActionLoading] = useState<string | null>(null);
  const [pingPhoneByDevice, setPingPhoneByDevice] = useState<Record<string, string>>({});
  const [pingLoadingDeviceId, setPingLoadingDeviceId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const tenantList = await apiJson<Tenant[]>('/tenants', token);
      setTenants(tenantList);
      const byTenant: Record<string, Device[]> = {};
      await Promise.all(
        tenantList.map(async (t) => {
          try {
            const devices = await apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(t.id)}`, token);
            byTenant[t.id] = devices.map(normalizeDevice);
          } catch {
            byTenant[t.id] = [];
          }
        })
      );
      setDevicesByTenant(byTenant);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Error al cargar');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const updateDeviceInTenant = useCallback((tenantId: string, updated: Device) => {
    setDevicesByTenant((prev) => ({
      ...prev,
      [tenantId]: (prev[tenantId] ?? []).map((d) => (d.id === updated.id ? { ...updated, label: updated.label || d.label } : d))
    }));
  }, []);

  const handleReconnect = async (device: Device) => {
    const tenantId = device.tenantId;
    if (!tenantId) return;
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}/connect`, token, { method: 'POST' });
      const d = await apiJson<Device>(`/devices/${device.id}/status`, token);
      updateDeviceInTenant(tenantId, normalizeDevice(d));
      setMsg(`Conectando "${device.label}" — escanea el QR en Dispositivos si hace falta.`);
    } catch (err: unknown) {
      setMsg(`Error al reconectar: ${err instanceof Error ? err.message : 'Error desconocido'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  const handleLogout = async (device: Device) => {
    const tenantId = device.tenantId;
    if (!tenantId) return;
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}/disconnect`, token, { method: 'POST' });
      const d = await apiJson<Device>(`/devices/${device.id}/status`, token);
      updateDeviceInTenant(tenantId, normalizeDevice(d));
      setMsg(`Sesión cerrada en "${device.label}".`);
    } catch (err: unknown) {
      setMsg(`Error al cerrar sesión: ${err instanceof Error ? err.message : 'Error desconocido'}`);
    } finally {
      setDeviceActionLoading(null);
    }
  };

  const handleResetSession = async (device: Device) => {
    const tenantId = device.tenantId;
    if (!tenantId) return;
    setDeviceActionLoading(device.id);
    try {
      await apiJson(`/devices/${device.id}/disconnect`, token, { method: 'POST' });
      await apiJson(`/devices/${device.id}/reset-session`, token, { method: 'POST' });
      const list = await apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(tenantId)}`, token);
      setDevicesByTenant((prev) => ({ ...prev, [tenantId]: list.map(normalizeDevice) }));
      setMsg(`Sesión reiniciada en "${device.label}". Pulsa Conectar para nuevo QR.`);
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
          ? `Sesiones de ${res.clearedCount} contacto(s) reiniciadas en "${device.label}". Si tenían "No matching sessions", que reenvíen el mensaje.`
          : `Listo. No había contactos recientes para reiniciar en "${device.label}".`
      );
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudieron reiniciar sesiones por contacto'}`);
    } finally {
      setDeviceActionLoading(null);
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

  if (loading) {
    return (
      <div className="card">
        <p className="muted">Cargando clientes y dispositivos...</p>
      </div>
    );
  }

  const tenantIds = tenants.map((t) => t.id);
  const totalDevices = tenantIds.reduce((acc, id) => acc + (devicesByTenant[id]?.length ?? 0), 0);

  return (
    <>
      <div className="card">
        <h3>Todos los dispositivos</h3>
        <p className="muted">
          {tenants.length} cliente(s), {totalDevices} dispositivo(s). Conectar, Reconectar, Desconectar, Reset connection, Ping.
        </p>
        {msg ? <div className="muted" style={{ marginTop: 8 }}>{msg}</div> : null}
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" onClick={loadAll}>
            Actualizar
          </button>
        </div>
      </div>
      {tenantIds.map((tenantId) => {
        const tenant = tenants.find((t) => t.id === tenantId);
        const devices = devicesByTenant[tenantId] ?? [];
        if (devices.length === 0) return null;
        return (
          <div key={tenantId} className="card">
            <h3>{tenant?.name ?? tenantId}</h3>
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
          </div>
        );
      })}
      {totalDevices === 0 && (
        <div className="card">
          <p className="muted">No hay dispositivos. Crea clientes y dispositivos en las pestañas Clientes y Dispositivos.</p>
        </div>
      )}
    </>
  );
}
