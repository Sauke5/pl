import { useQuery } from '@tanstack/react-query';
import { appBase } from '../api/client';
import type { PortalSession } from './shared';

export function usePlatformSession() {
  return useQuery({
    queryKey: ['platform-session'], enabled: Boolean(appBase), retry: false,
    queryFn: async () => {
      const response = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Сессия Платформы недоступна');
      return response.json() as Promise<PortalSession>;
    },
  });
}
