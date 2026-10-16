/**
 * `useAppAssertion()` (ADR 0045): this app's Oxy-signed assertion of which app
 * it is, for the signed-in session.
 *
 * `OxyProvider` mounts {@link AppAssertionProvider} itself and the manager
 * obtains and refreshes the assertion on its own; an app never handles the
 * proof. Something that calls a service which needs to know the app (Alia's
 * SDK, for an agent confined to its application) attaches
 * `await getAppAssertionHeaders()` to the request.
 */

import type { OxyServices } from '@oxy.so/core';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { StorageInterface } from '../utils/storageHelpers';
import { appIntegrityPlatform } from './appIntegrityPlatform';
import { AppAssertionManager, type AppAssertionSnapshot } from './appAssertionManager';
import type { AppIntegrityPlatform } from './appIntegrityTypes';

const AppAssertionContext = createContext<AppAssertionManager | null>(null);

export interface AppAssertionProviderProps {
  readonly children: ReactNode;
  readonly oxyServices: OxyServices;
  readonly clientId: string | null;
  /** The signed-in person, once the session can call Oxy; `null` otherwise. */
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly storage: StorageInterface | null;
  readonly storageKeyPrefix: string;
  /** Replaces the build's own platform, in tests. */
  readonly integrity?: AppIntegrityPlatform;
}

export function AppAssertionProvider({
  children,
  oxyServices,
  clientId,
  userId,
  sessionId,
  storage,
  storageKeyPrefix,
  integrity = appIntegrityPlatform,
}: AppAssertionProviderProps) {
  // Read only when an iOS install needs its App Attest key id, never in render.
  const storageRef = useRef<StorageInterface | null>(storage);
  useEffect(() => {
    storageRef.current = storage;
  }, [storage]);

  const manager = useMemo(
    () =>
      new AppAssertionManager({
        oxyServices,
        clientId,
        integrity,
        storage: () => storageRef.current,
        storageKeyPrefix,
      }),
    [oxyServices, clientId, integrity, storageKeyPrefix],
  );

  useEffect(() => {
    manager.setSession(userId && sessionId ? { userId, sessionId } : null);
  }, [manager, userId, sessionId]);

  useEffect(() => () => manager.dispose(), [manager]);

  return <AppAssertionContext.Provider value={manager}>{children}</AppAssertionContext.Provider>;
}

export interface UseAppAssertionResult extends AppAssertionSnapshot {
  /** A current assertion, obtained now when there is none or it is about to expire; `null` when there can be none. */
  readonly getAppAssertion: () => Promise<string | null>;
  /** `{ 'X-Oxy-App-Assertion': <assertion> }`, or `{}` when there is none. */
  readonly getAppAssertionHeaders: () => Promise<Record<string, string>>;
}

export class AppAssertionProviderMissingError extends Error {
  readonly code = 'oxy_provider_missing';

  constructor() {
    super('useAppAssertion() was called outside <OxyProvider>.');
    this.name = 'AppAssertionProviderMissingError';
  }
}

/** This app's assertion of which app it is, kept current for the signed-in session. */
export function useAppAssertion(): UseAppAssertionResult {
  const manager = useContext(AppAssertionContext);
  if (!manager) throw new AppAssertionProviderMissingError();
  const snapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot,
  );
  return {
    ...snapshot,
    getAppAssertion: manager.getAppAssertion,
    getAppAssertionHeaders: manager.getAppAssertionHeaders,
  };
}
