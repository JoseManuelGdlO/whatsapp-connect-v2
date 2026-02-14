import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { apiJson } from '../../api/client';
import type { Device, OutboundMessage } from '../../types';

export function DevicesAdmin({ token, tenantIdOverride }: { token: string; tenantIdOverride: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [filterTenantId, setFilterTenantId] = useState<string>(tenantIdOverride);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('ping');
  const [outbound, setOutbound] = useState<OutboundMessage[]>([]);

  useEffect(() => {
    const loadDevices = async () => {
      if (!filterTenantId) {
        setDevices([]);
        return;
      }
      try {
        const data = await apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(filterTenantId)}`, token);
        setDevices(data.map((d) => ({ ...d, label: d.label || d.id || 'Device sin nombre' })));
      } catch (err: unknown) {
        setMsg(`Error al cargar dispositivos: ${err instanceof Error ? err.message : 'error'}`);
      }
    };
    loadDevices();
  }, [token, filterTenantId]);

  useEffect(() => {
    if (!token || !selectedId) {
      setSelectedDevice(null);
      setQrDataUrl(null);
      setOutbound([]);
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
        const out = await apiJson<OutboundMessage[]>(`/devices/${selectedId}/messages/outbound`, token);
        if (alive) setOutbound(out);
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
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo eliminar el dispositivo'}`);
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
    } catch (err: unknown) {
      setMsg(`Error al conectar: ${err instanceof Error ? err.message : 'Error desconocido'}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (deviceId: string) => {
    try {
      await apiJson(`/devices/${deviceId}/disconnect`, token, { method: 'POST' });
      setQrDataUrl(null);
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo desconectar'}`);
    }
  };

  const handleResetSession = async (device: Device) => {
    try {
      await apiJson(`/devices/${device.id}/disconnect`, token, { method: 'POST' });
      await apiJson(`/devices/${device.id}/reset-session`, token, { method: 'POST' });
      setMsg('Sesión reiniciada. Haz clic en Conectar para obtener un nuevo QR.');
      setSelectedId(device.id);
    } catch (err: unknown) {
      setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo reiniciar la sesión'}`);
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
                } catch (err: unknown) {
                  setMsg(`Error al crear: ${err instanceof Error ? err.message : 'Error desconocido'}`);
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
                  } catch (err: unknown) {
                    setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo generar el link'}`);
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

          <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #e2e8f0' }} />
          <h3>Ping por dispositivo</h3>
          <p className="muted">Envía un mensaje de prueba para comprobar si el dispositivo está conectado a WhatsApp.</p>
          <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="Número: 521XXXXXXXXXX"
              style={{ minWidth: 160 }}
            />
            <input
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder="Texto (ej. ping)"
              style={{ minWidth: 120 }}
            />
            <button
              type="button"
              onClick={async () => {
                if (!selectedDevice) return;
                setMsg(null);
                try {
                  await apiJson(`/devices/${selectedDevice.id}/messages/test`, token, {
                    method: 'POST',
                    body: JSON.stringify({ to: testTo, text: testText })
                  });
                  setMsg('Mensaje enviado. Revisa "Últimos envíos" para ver si llegó.');
                } catch (err: unknown) {
                  setMsg(`Error: ${err instanceof Error ? err.message : 'No se pudo enviar'}`);
                }
              }}
            >
              Enviar ping
            </button>
          </div>
          {msg ? <div className="muted" style={{ marginTop: 8 }}>{msg}</div> : null}
          <h4 style={{ marginTop: 16, fontSize: 14 }}>Últimos envíos</h4>
          <div className="list" style={{ maxHeight: 200, overflow: 'auto' }}>
            {outbound.length === 0 ? (
              <div className="muted" style={{ padding: 8 }}>Aún no hay envíos. Envía un ping arriba.</div>
            ) : (
              outbound.map((o) => (
                <div key={o.id} className="row" style={{ cursor: 'default', padding: '6px 0' }}>
                  <div>
                    <div className="rowTitle" style={{ fontSize: 13 }}>
                      {o.isTest ? '[TEST] ' : ''}{o.to}
                    </div>
                    <div className="rowMeta" style={{ fontSize: 12 }}>
                      {o.status}
                      {o.error ? ` · ${o.error}` : ''}
                    </div>
                  </div>
                  <div className="rowRight">{o.providerMessageId ? 'enviado' : ''}</div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : selectedId ? (
        <div className="card">
          <p className="muted">Cargando estado del dispositivo...</p>
        </div>
      ) : null}
    </>
  );
}
