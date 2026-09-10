import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthMethodEntry, AuthMethodsResponse } from '@oxy.so/contracts';
import { queryKeys } from './queryKeys';
import { useOxy } from '../../context/OxyContext';

/** Stable empty list so the derived selectors keep a stable reference while loading. */
const EMPTY_METHODS: readonly AuthMethodEntry[] = Object.freeze([]);

/**
 * The current account's linked authentication methods (`GET /auth/methods`),
 * plus convenience projections. Backs the security / account surfaces that let a
 * user see and manage their passwords, identity key, social logins, and passkeys.
 *
 * `passkeys` is the `type === 'webauthn'` subset — one entry per registered
 * credential. Invalidate via `queryKeys.authMethods.all` after linking a passkey
 * (`useOxy().addPasskey()` does this) or removing one.
 */
export const useAuthMethods = (options?: { enabled?: boolean }) => {
  const { oxyServices, activeSessionId } = useOxy();

  const query = useQuery<AuthMethodsResponse>({
    queryKey: queryKeys.authMethods.list(),
    queryFn: () => oxyServices.listAuthMethods(),
    enabled: options?.enabled !== false && !!activeSessionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });

  const methods = query.data?.methods ?? EMPTY_METHODS;
  const passkeys = useMemo(
    () => methods.filter((method) => method.type === 'webauthn'),
    [methods],
  );

  return {
    ...query,
    /** Every linked auth method. Empty while loading. */
    methods,
    /** The registered passkeys (a `type === 'webauthn'` subset of `methods`). */
    passkeys,
    /** The account's DID, or `null` while loading. */
    did: query.data?.did ?? null,
  };
};
