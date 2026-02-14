import { useAuth } from '../../state/auth';
import { useTenantId } from '../../hooks';

export function TenantSelector() {
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
