import { type RecordView, skip, useRecord } from '@oxy.so/bloom-data';
import type { AuthMethodEntry, AuthMethodsResponse, SignInMethods } from '@oxy.so/contracts';
import { useOxy } from '../../context/oxyRuntimeContext';
import { authMethods, signInMethods } from '../../data/security';

/** Stable empty list so the derived fields keep a stable reference while loading. */
const EMPTY_METHODS: readonly AuthMethodEntry[] = Object.freeze([]);

export interface AuthMethodsView extends RecordView<AuthMethodsResponse> {
  /** Every linked auth method. Empty while loading. */
  readonly methods: readonly AuthMethodEntry[];
  /** The account's DID, or `null` while loading. */
  readonly did: string | null;
}

/**
 * The current account's linked authentication methods (`GET /auth/methods`).
 * Backs the security / account surfaces that let a user see their identity key
 * and social logins. Waits for an active session.
 */
export const useAuthMethods = (options?: { enabled?: boolean }): AuthMethodsView => {
  const { oxyServices, activeSessionId } = useOxy();
  const view = useRecord(
    authMethods,
    ...(options?.enabled !== false && activeSessionId
      ? ([oxyServices] as const)
      : ([skip] as const)),
  );
  return {
    ...view,
    methods: view.value?.methods ?? EMPTY_METHODS,
    did: view.value?.did ?? null,
  };
};

/**
 * How the signed-in account signs in (`GET /users/me/sign-in-methods`): whether
 * it has an email, a password, an authenticator app, and how many backup codes
 * are left. Call `refresh()` after changing any of them (the security panels
 * do). Waits for an active session.
 */
export const useSignInMethods = (options?: { enabled?: boolean }): RecordView<SignInMethods> => {
  const { oxyServices, activeSessionId } = useOxy();
  return useRecord(
    signInMethods,
    ...(options?.enabled !== false && activeSessionId
      ? ([oxyServices] as const)
      : ([skip] as const)),
  );
};
