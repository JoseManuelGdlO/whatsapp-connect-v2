import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../api/client';

const SERVICE_SCOPES = [
  'devices:status:read',
  'devices:public-link:write',
  'messages:send',
  'messages:test'
] as const;

type ServiceScope = (typeof SERVICE_SCOPES)[number];

type ServiceTokenRow = {
  id: string;
  service: string;
  scopes: ServiceScope[];
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type CreateServiceTokenResponse = {
  id: string;
  tokenType: 'service_jwt';
  service: string;
  scopes: ServiceScope[];
  token: string;
};

export function ServiceTokensAdmin({ token }: { token: string }) {
  const [rows, setRows] = useState<ServiceTokenRow[]>([]);
  const [service, setService] = useState('car-advisor-bot');
  const [selectedScopes, setSelectedScopes] = useState<ServiceScope[]>([...SERVICE_SCOPES]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedCount = useMemo(() => selectedScopes.length, [selectedScopes]);

  const loadTokens = async () => {
    const list = await apiJson<ServiceTokenRow[]>('/auth/service-jwt', token);
    setRows(list);
  };

  useEffect(() => {
    loadTokens().catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : 'No se pudieron cargar los tokens';
      setMsg(errorMsg);
    });
  }, [token]);

  const toggleScope = (scope: ServiceScope) => {
    setSelectedScopes((prev) => {
      if (prev.includes(scope)) return prev.filter((s) => s !== scope);
      return [...prev, scope];
    });
  };

  const handleCreateToken = async () => {
    if (!service.trim()) {
      setMsg('El nombre de service es requerido');
      return;
    }
    if (selectedScopes.length === 0) {
      setMsg('Selecciona al menos un scope');
      return;
    }
    setLoading(true);
    setMsg(null);
    setCreatedToken(null);
    try {
      const created = await apiJson<CreateServiceTokenResponse>('/auth/service-jwt', token, {
        method: 'POST',
        body: JSON.stringify({ service: service.trim(), scopes: selectedScopes })
      });
      setCreatedToken(created.token);
      setMsg(`Token creado para "${created.service}"`);
      await loadTokens();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'No se pudo crear el token';
      setMsg(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setLoading(true);
    setMsg(null);
    try {
      await apiJson<{ ok: boolean }>(`/auth/service-jwt/${id}/revoke`, token, {
        method: 'POST'
      });
      setMsg('Token revocado');
      await loadTokens();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'No se pudo revocar el token';
      setMsg(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="card">
        <h3>Service Tokens</h3>
        <p className="muted">Genera tokens de servicio con scopes para integraciones externas.</p>
        <div className="form" style={{ marginTop: 12 }}>
          <label>
            Service
            <input value={service} onChange={(e) => setService(e.target.value)} placeholder="car-advisor-bot" />
          </label>

          <div>
            <div className="muted" style={{ marginBottom: 8 }}>
              Scopes seleccionados: {selectedCount}
            </div>
            <div className="actions">
              {SERVICE_SCOPES.map((scope) => (
                <label key={scope} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span>{scope}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="actions">
            <button type="button" onClick={handleCreateToken} disabled={loading}>
              {loading ? '...' : 'Generar token'}
            </button>
            <button
              type="button"
              onClick={() => loadTokens().catch(() => setMsg('No se pudo actualizar la lista'))}
              disabled={loading}
            >
              Listar tokens
            </button>
          </div>
          {msg ? <div className="muted">{msg}</div> : null}
        </div>

        {createdToken ? (
          <div style={{ marginTop: 12 }}>
            <div className="muted">Token generado (guárdalo, no vuelve a mostrarse):</div>
            <textarea readOnly value={createdToken} rows={4} style={{ width: '100%' }} />
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>Tokens creados</h3>
        <div className="list">
          {rows.map((row) => (
            <div key={row.id} className="row" style={{ cursor: 'default' }}>
              <div>
                <div className="rowTitle">{row.service}</div>
                <div className="rowMeta">
                  {row.id} · scopes: {Array.isArray(row.scopes) ? row.scopes.join(', ') : '-'}
                </div>
                <div className="rowMeta">
                  creado: {new Date(row.createdAt).toLocaleString()} · ultimo uso:{' '}
                  {row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : 'nunca'}
                </div>
              </div>
              <div className="actions">
                {row.revokedAt ? (
                  <span className="muted">Revocado</span>
                ) : (
                  <button type="button" onClick={() => handleRevoke(row.id)} disabled={loading}>
                    Revocar
                  </button>
                )}
              </div>
            </div>
          ))}
          {rows.length === 0 ? <div className="muted">No hay tokens de servicio.</div> : null}
        </div>
      </div>
    </>
  );
}
