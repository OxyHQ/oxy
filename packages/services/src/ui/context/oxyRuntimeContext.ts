import { createContext, useContext } from 'react';
import type { OxyContextState } from './oxyContextTypes';

export const OxyRuntimeContext = createContext<OxyContextState | null>(null);

const PROVIDER_MISSING_ERROR_MESSAGE =
  'useOxy() was called outside <OxyProvider>. Mount <OxyProvider clientId="…"> above this component, ' +
  'or use useOptionalOxy() if this component legitimately renders both inside and outside the provider.';

export class OxyProviderMissingError extends Error {
  readonly code = 'oxy_provider_missing';

  constructor() {
    super(PROVIDER_MISSING_ERROR_MESSAGE);
    this.name = 'OxyProviderMissingError';
  }
}

/**
 * The base runtime hook. THROWS when no `<OxyProvider>` is mounted.
 *
 * It used to return a fabricated forever-loading runtime — `isLoading: true`,
 * `isPrivateApiPending: true`, every method a rejecting no-op — which turned a
 * missing provider into a UI that spins forever with nothing in the console.
 * Failing here names the mistake at the exact component that made it (ADR 0004).
 *
 * A component that legitimately renders both inside and outside the provider
 * uses {@link useOptionalOxy} instead.
 */
export const useOxy = (): OxyContextState => {
  const context = useContext(OxyRuntimeContext);
  if (!context) {
    throw new OxyProviderMissingError();
  }
  return context;
};

/**
 * `useOxy()` for the rare component that renders both inside and outside the
 * provider — returns `null` instead of throwing. Callers must handle `null`;
 * there is no fabricated runtime to fall back on.
 */
export const useOptionalOxy = (): OxyContextState | null => useContext(OxyRuntimeContext);

export type OxyAuthActionsContextState = Pick<
  OxyContextState,
  | 'signIn'
  | 'logout'
  | 'logoutAll'
  | 'refreshSessions'
  | 'oxyServices'
  | 'switchToAccount'
  | 'hasIdentity'
  | 'getPublicKey'
  | 'showBottomSheet'
  | 'openAvatarPicker'
  | 'openAccountDialog'
> & { ensureDeviceSessionLane: () => void | Promise<void> };

export const OxyAuthActionsContext = createContext<OxyAuthActionsContextState | null>(null);

/** Stable auth commands for selector-based hooks; never carries mutable state. */
export const useOxyAuthActions = (): OxyAuthActionsContextState => {
  const actions = useContext(OxyAuthActionsContext);
  if (!actions) {
    throw new OxyProviderMissingError();
  }
  return actions;
};
