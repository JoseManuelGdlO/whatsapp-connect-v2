import { useEffect, useState } from 'react';
import { apiJson } from '../../api/client';
import { useTenantId } from '../../hooks';
import { useAuth } from '../../state/auth';
import type { WebhookEndpoint } from '../../types';
import { TenantSelector } from '../admin/TenantSelector';

export function WebhooksPage() {
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
              const body: Record<string, string> = { url };
              if (secret) body.secret = secret;
              body.tenantId = tenantId;
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
