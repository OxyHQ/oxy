import { useQuery } from '@tanstack/react-query';
import type { AuthMethodEntry, AuthMethodsResponse, SignInMethods } from '@oxy.so/contracts';
import { queryKeys } from './queryKeys';
import { useOxy } from '../../context/OxyContext';

/** Stable empty list so the derived selectors keep a stable reference while loading. */
const EMPTY_METHODS: readonly AuthMethodEntry[] = Object.freeze([]);

/**
 * The current account's linked authentication methods (`GET /auth/methods`).
 * Backs the security / account surfaces that let a user see their identity key
 * and social logins.
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

  return {
    ...query,
    /** Every linked auth method. Empty while loading. */
    methods: query.data?.methods ?? EMPTY_METHODS,
    /** The account's DID, or `null` while loading. */
    did: query.data?.did ?? null,
  };
};

/**
 * How the signed-in account signs in (`GET /users/me/sign-in-methods`): whether
 * it has an email, a password, an authenticator app, and how many backup codes
 * are left. Invalidate `queryKeys.signInMethods.all` after changing any of them
 * (the security panels do).
 */
export const useSignInMethods = (options?: { enabled?: boolean }) => {
  const { oxyServices, activeSessionId, user } = useOxy();
  return useQuery<SignInMethods>({
    queryKey: queryKeys.signInMethods.current(user?.id),
    queryFn: () => oxyServices.getSignInMethods(),
    enabled: options?.enabled !== false && !!activeSessionId,
    staleTime: 60 * 1000,
  });
};
