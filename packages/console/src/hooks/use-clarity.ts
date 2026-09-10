import { ClarityClient } from '@clarity.surf/sdk';
import { useAuth } from '@oxy.so/services';
import { useMemo } from 'react';
import config from '@/lib/config';

/** Clarity authenticates the currently active Oxy account session by introspection. */
export function useClarityClient(): ClarityClient {
  const { oxyServices } = useAuth();

  return useMemo(
    () =>
      new ClarityClient({
        baseUrl: config.clarityUrl,
        getAccessToken: () => {
          const token = oxyServices.getAccessToken();
          if (!token) throw new Error('Your Oxy session is not ready.');
          return token;
        },
      }),
    [oxyServices],
  );
}
