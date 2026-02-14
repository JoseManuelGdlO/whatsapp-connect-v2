import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../state/auth';

export function useTenantId() {
  const { user } = useAuth();
  const [tenantIdOverride, setTenantIdOverride] = useState<string>(() => localStorage.getItem('tenantId') ?? '');

  useEffect(() => {
    if (!user) {
      if (tenantIdOverride) {
        setTenantIdOverride('');
        localStorage.removeItem('tenantId');
      }
      return;
    }

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
