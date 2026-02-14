import { useEffect, useState } from 'react';
import { apiJson } from '../../api/client';
import type { WebhookEndpoint } from '../../types';

export function WebhooksAdmin({ token, tenantIdOverride }: { token: string; tenantIdOverride: string }) {
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
                const body: Record<string, string> = { url, tenantId: tenantIdOverride };
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
