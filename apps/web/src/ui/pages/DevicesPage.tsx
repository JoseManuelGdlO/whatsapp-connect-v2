import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { apiJson } from '../../api/client';
import { useTenantId } from '../../hooks';
import { useAuth } from '../../state/auth';
import type { Device, OutboundMessage } from '../../types';
import { TenantSelector } from '../admin/TenantSelector';
import { DeviceLinkPanel } from '../components/DeviceLinkPanel';

export function DevicesPage() {
  const { token, user } = useAuth();
  const { tenantId } = useTenantId();

  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => devices.find((d) => d.id === selectedId) ?? null, [devices, selectedId]);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [connectPhone, setConnectPhone] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [connecting, setConnecting] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('ping');
  const [outbound, setOutbound] = useState<OutboundMessage[]>([]);

  const loadDevices = useCallback(async () => {
    if (!token || !tenantId) return;
    try {
      const devices = await apiJson<Device[]>(`/devices?tenantId=${encodeURIComponent(tenantId)}`, token);
      const devicesWithLabels = devices.map((d) => ({
        ...d,
        label: d.label || 'Device sin nombre'
      }));
      setDevices(devicesWithLabels);
    } catch {
      // ignore
    }
  }, [token, tenantId]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (!token || !tenantId) return;
    const t = setInterval(() => void loadDevices(), 5000);
    return () => clearInterval(t);
  }, [token, tenantId, loadDevices]);

  useEffect(() => {
    if (!token || !tenantId || !selectedId) return;
    let alive = true;

    const tick = async () => {
      try {
        const d = await apiJson<Device>(`/devices/${selectedId}/status`, token);
        if (!alive) return;
        setDevices((prev) =>
          prev.map((x) => {
            if (x.id === d.id) {
              return { ...d, label: d.label || x.label || 'Device' };
            }
            return x;
          })
        );

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

  useEffect(() => {
    setConnectPhone(selected?.phoneHint ?? '');
  }, [selectedId, selected?.phoneHint]);

  return (
    <div className="grid">
      <div className="card">
        <h2>Devices</h2>
        <p className="muted">Selecciona un device y conecta por QR o código de emparejamiento.</p>

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
              const body: Record<string, string> = { label };
              if (user?.role === 'SUPERADMIN') body.tenantId = tenantId;
              try {
                const d = await apiJson<Device>('/devices', token, { method: 'POST', body: JSON.stringify(body) });
                setDevices((prev) => [d, ...prev]);
                setSelectedId(d.id);
                setNewLabel('');
              } catch (err: unknown) {
                alert(`Error al crear dispositivo: ${err instanceof Error ? err.message : 'Error desconocido'}`);
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
                  <div style={{ fontSize: '11px', color: '#475569', marginBottom: '2px', wordBreak: 'break-all' }}>
                    ID: {d.id}
                    {d.phoneHint ? ` · PhoneHint: ${d.phoneHint}` : ''}
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
                  } catch (err: unknown) {
                    alert(`Error: ${err instanceof Error ? err.message : 'No se pudo eliminar el dispositivo'}`);
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
            <div className="actions" style={{ marginBottom: 8 }}>
              <input
                value={connectPhone}
                onChange={(e) => setConnectPhone(e.target.value)}
                placeholder="Teléfono (código): 521XXXXXXXXXX"
                style={{ minWidth: 220 }}
              />
            </div>
            <div className="actions">
              <button
                disabled={connecting}
                onClick={async () => {
                  if (!token || !selected) return;
                  setConnecting(true);
                  try {
                    const body = connectPhone.trim()
                      ? JSON.stringify({ phoneNumber: connectPhone.trim() })
                      : undefined;
                    await apiJson(`/devices/${selected.id}/connect`, token!, { method: 'POST', body });
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
                  } catch (err: unknown) {
                    alert(`Error al conectar: ${err instanceof Error ? err.message : 'Error desconocido'}`);
                  } finally {
                    setConnecting(false);
                  }
                }}
              >
                {connecting ? 'Conectando...' : 'Connect'}
              </button>
              <button
                title="La sesión sigue guardada; al reiniciar el worker puede reconectarse solo."
                onClick={async () => {
                  await apiJson(`/devices/${selected.id}/disconnect`, token!, { method: 'POST' });
                  alert('Conexión pausada. La sesión sigue guardada.');
                }}
              >
                Pausar conexión
              </button>
              <button
                title="Borra la vinculación; hará falta escanear QR o usar código de nuevo."
                onClick={async () => {
                  if (
                    !confirm(
                      '¿Desvincular WhatsApp? Se borrará la sesión guardada y habrá que escanear el QR o usar el código de nuevo. Esta acción no se puede deshacer desde el teléfono automáticamente.'
                    )
                  ) {
                    return;
                  }
                  await apiJson(`/devices/${selected.id}/reset-session`, token!, { method: 'POST' });
                  alert('WhatsApp desvinculado. Escanea un QR o usa el código para conectar.');
                }}
              >
                Desvincular WhatsApp (borrar sesión)
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await apiJson<{ ok: boolean; clearedCount: number }>(
                      `/devices/${selected.id}/reset-sender-sessions`,
                      token!,
                      { method: 'POST' }
                    );
                    alert(
                      res.clearedCount > 0
                        ? `Cifrado reiniciado para ${res.clearedCount} chat(s). Si veían "No matching sessions", que reenvíen el mensaje.`
                        : 'Listo. No había chats recientes en el historial para reparar.'
                    );
                  } catch (err: unknown) {
                    alert(`Error: ${err instanceof Error ? err.message : 'No se pudo reparar el cifrado de chats'}`);
                  }
                }}
                title="Reinicia claves de cifrado por chat (errores de lectura). No desvincula el dispositivo."
              >
                Reparar cifrado de chats
              </button>
              {selected.status === 'QR' && (
                <button
                  onClick={async () => {
                    try {
                      const result = await apiJson<{ url: string }>(`/devices/${selected.id}/public-link`, token!, { method: 'POST' });
                      await navigator.clipboard.writeText(result.url);
                      alert('Link público copiado al portapapeles!');
                    } catch (err: unknown) {
                      alert(`Error: ${err instanceof Error ? err.message : 'No se pudo generar el link'}`);
                    }
                  }}
                >
                  Copiar Link Público
                </button>
              )}
            </div>
            <div
              style={{
                marginTop: 8,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap'
              }}
            >
              <span className="muted">Device ID:</span>
              <code
                style={{
                  fontSize: '12px',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  padding: '2px 6px'
                }}
              >
                {selected.id}
              </code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(selected.id);
                    alert('Device ID copiado al portapapeles.');
                  } catch (err: unknown) {
                    alert(`Error: ${err instanceof Error ? err.message : 'No se pudo copiar el Device ID'}`);
                  }
                }}
                style={{ padding: '4px 8px', fontSize: '12px' }}
              >
                Copiar ID
              </button>
            </div>

            <DeviceLinkPanel
              qrDataUrl={qrDataUrl}
              pairingCode={selected.pairingCode}
              deviceLabel={selected.label}
              isLinking={selected.status === 'QR'}
              needsPhoneForPairing={!connectPhone.trim() && !selected.pairingCode}
            />
            {selected.status === 'ERROR' && selected.lastError ? (
              <div className="error">
                <strong>Error:</strong> {selected.lastError}
                <br />
                <small>Prueba &quot;Desvincular WhatsApp (borrar sesión)&quot; y luego &quot;Connect&quot; de nuevo.</small>
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
