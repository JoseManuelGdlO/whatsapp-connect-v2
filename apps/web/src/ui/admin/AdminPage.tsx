import { useState } from 'react';
import { API_URL } from '../../api/client';
import { useTenantId } from '../../hooks';
import { useAuth } from '../../state/auth';
import { ClientesAdmin } from './ClientesAdmin';
import { ConversationsTrace } from './ConversationsTrace';
import { DevicesAdmin } from './DevicesAdmin';
import { TenantSelector } from './TenantSelector';
import { WebhooksAdmin } from './WebhooksAdmin';

export function AdminPage() {
  const { token, user } = useAuth();
  const { tenantIdOverride, setTenantIdOverride } = useTenantId();
  const [active, setActive] = useState<'clientes' | 'devices' | 'webhooks' | 'conversations'>('clientes');
  const [pingStatus, setPingStatus] = useState<string | null>(null);
  const [pingLoading, setPingLoading] = useState(false);

  const handlePing = async () => {
    setPingLoading(true);
    setPingStatus(null);
    const start = performance.now();
    try {
      const res = await fetch(`${API_URL}/health`);
      const ms = Math.round(performance.now() - start);
      const data = await res.json();
      if (res.ok && data?.ok) {
        setPingStatus(`API conectado (${ms} ms)`);
      } else {
        setPingStatus(`API respondió: ${res.status}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sin conexión';
      setPingStatus(`Error: ${msg}`);
    } finally {
      setPingLoading(false);
    }
  };

  if (user?.role !== 'SUPERADMIN') return <div className="card">Forbidden</div>;

  return (
    <div className="grid">
      <div className="card">
        <h2>Admin</h2>
        <div className="actions">
          <button onClick={() => setActive('clientes')}>Clientes</button>
          <button onClick={() => setActive('devices')}>Dispositivos</button>
          <button onClick={() => setActive('conversations')}>Conversaciones</button>
          <button onClick={() => setActive('webhooks')}>Webhooks</button>
        </div>
        <p className="muted">Selecciona un cliente para gestionar sus dispositivos y webhooks.</p>
        <div className="actions" style={{ marginTop: 8, alignItems: 'center', gap: 8 }}>
          <button type="button" onClick={handlePing} disabled={pingLoading}>
            {pingLoading ? '...' : 'Ping API'}
          </button>
          {pingStatus != null && (
            <span className={pingStatus.startsWith('Error') ? 'error' : 'muted'} style={{ fontSize: 14 }}>
              {pingStatus}
            </span>
          )}
        </div>
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
      ) : active === 'conversations' ? (
        <ConversationsTrace token={token!} tenantIdOverride={tenantIdOverride} />
      ) : (
        <WebhooksAdmin token={token!} tenantIdOverride={tenantIdOverride} />
      )}
    </div>
  );
}
