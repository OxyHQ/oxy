import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Linking } from 'react-native';
import { io } from 'socket.io-client';
import { OxyServices, oxyClient } from '@oxyhq/core';
import type {
  User,
  SessionLoginResponse,
  AuthStateStore,
  PersistedAuthState,
  AccountDialogController,
  AccountDialogView,
} from '@oxyhq/core';
import {
  KeyManager,
  establishIdentitySession,
  installAuthRefreshHandler,
  startTokenRefreshScheduler,
  createAccountDialogController,
  logger as loggerUtil,
} from '@oxyhq/core';
import {
  registerAccountDialogControls,
  notifyAccountDialogVisibility,
} from '../navigation/accountDialogManager';
import { redirectToAuthorize } from '../components/oauthNavigation';
import { openPasskeyHubPopup } from '../components/passkeyHubPopup';
import {
  startWebOAuthSignIn,
  type StartWebOAuthSignInOptions,
} from '../oauth/browserAuthTransport';
import type { WebOAuthSignInResult } from '../oauth/types';
import { isWebBrowser } from '../utils/isWebBrowser';
import { resolveDeliveryPlatform } from '../utils/deliveryPlatform';
import { runProviderColdBoot } from '../boot/runProviderColdBoot';
import { loadPersistedDeviceCredential } from '../utils/deviceCredential';
import { bindAuthStoreToRuntime } from '../stores/authStore';
import { useLanguageManagement } from '../hooks/useLanguageManagement';
import { useSessionManagement } from '../hooks/useSessionManagement';
import { useAuthOperations, clearPersistedAuthSafe } from './hooks/useAuthOperations';
import { useDeviceManagement } from '../hooks/useDeviceManagement';
import { getStorageKeys, createPlatformStorage, type StorageInterface } from '../utils/storageHelpers';
import type { RouteName } from '../navigation/routes';
import { showBottomSheet as globalShowBottomSheet } from '../navigation/bottomSheetManager';
import {
  presentDetached,
  topRouteSurface,
  type SurfaceInstance,
  type TrackedSurface,
} from '../navigation/surfaces';
import { useQueryClient, onlineManager } from '@tanstack/react-query';
import { clearQueryCache } from '../hooks/queryClient';
import { useAvatarPicker } from '../hooks/useAvatarPicker';
import { resetSessionScopedStores } from '../stores/resetSessionScopedStores';
import { ASSET_DOWNLOAD_URLS_QUERY_KEY } from '../hooks/useResolvedFileUrls';
import {
  createOxyRuntime,
  OxyRuntimeHandleProvider,
  useRuntimeSnapshot,
  type OxyRuntime,
  type SubjectTransition,
} from '../runtime';
import {
  createSessionClient,
  createIdentitySessionBinding,
  createPlatformAuthStateStore,
  deviceStateToClientSessions,
  activeSessionIdOf,
  activeUserOf,
  accountIdsOf,
  IdentityBoundSessionError,
  useBackgroundSessionSync,
  type IdentitySessionBinding,
} from '../session';
import type {
  OxyContextState,
  OxyRuntimeProviderProps,
  CommitInput,
} from './oxyContextTypes';
import { DEFAULT_SESSION_VALIDITY_MS } from './oxyContextHelpers';
// `useFollow` imports this module back, so the binding must only be READ inside
// the provider body — at render time, once every module has evaluated. It is
// never dereferenced at module scope here.
import { useFollow } from '../hooks/useFollow';
import { commitDeviceSetAndResolve } from './commitSessionFlow';
import { runPasskeyLogin, runPasskeyRegister, runPasskeyAdd } from './passkeyFlow';
import {
  isPasskeySupported,
  runRegistrationCeremony,
  runAuthenticationCeremony,
} from '../../webauthn/passkeyClient';
import { queryKeys } from '../hooks/queries/queryKeys';
import { useOxyAccountGraph } from './useOxyAccountGraph';

export type { OxyContextState, OxyRuntimeProviderProps } from './oxyContextTypes';

const OxyRuntimeContext = createContext<OxyContextState | null>(null);

/**
 * The SDK's internal runtime provider — the session/account state machine that
 * backs `useOxy()`.
 *
 * This is NOT the component consumers mount. The one public composition root is
 * `OxyProvider` (`../components/OxyProvider`), which mounts this alongside the
 * QueryClient, Bloom's dialog/surface/toast hosts, safe areas, the gesture root
 * and the keyboard provider. Naming both of them `OxyProvider` (as this file
 * used to) made every error message, stack frame and doc reference ambiguous —
 * see ADR 0004.
 */
export const OxyRuntimeProvider: React.FC<OxyRuntimeProviderProps> = ({
  children,
  oxyServices: providedOxyServices,
  baseURL,
  authWebUrl,
  authRedirectUri,
  authorizeBaseUrl,
  storageKeyPrefix = 'oxy_session',
  clientId: clientIdProp,
  sessionMode = 'account',
  webAuthMode = 'popup',
  backgroundSession = false,
  onAuthStateChange,
  onError,
}) => {
  const oxyServicesRef = useRef<OxyServices | null>(null);
  if (!oxyServicesRef.current) {
    if (providedOxyServices) {
      oxyServicesRef.current = providedOxyServices;
    } else if (baseURL) {
      // `authWebUrl` now only points the OAuth "Sign in with Oxy" third-party
      // link builder at the central auth host; there is no cold-boot redirect.
      oxyServicesRef.current = new OxyServices({ baseURL, authWebUrl, authRedirectUri });
    } else {
      throw new Error('Either oxyServices or baseURL must be provided to OxyProvider');
    }
  }
  const oxyServices = oxyServicesRef.current;

  // The device-first persisted auth-state store (per-origin zero-cookie device
  // credential on web; SecureStore session blob on native). Built ONCE per
  // provider mount.
  const authStoreRef = useRef<AuthStateStore | null>(null);
  if (!authStoreRef.current) {
    authStoreRef.current = createPlatformAuthStateStore();
  }
  const authStore = authStoreRef.current;

  // Identity-bound session binding (`sessionMode: 'identity'`) — the platform pin
  // store plus the memoised pinned account id every lane below binds to. Built
  // ONCE per provider mount and ONLY in identity mode: an account-mode provider
  // never constructs one, so `identity` is `null` there and every branch keyed on
  // it collapses to today's behaviour.
  //
  // Like `oxyServices` / `baseURL`, `sessionMode` is mount-time configuration: it
  // is read once and a later change does not re-bind the provider. Latching it
  // this way also fails SAFE — a provider that started identity-bound can never
  // be downgraded mid-flight into following the device's active account.
  const identityRef = useRef<IdentitySessionBinding | null>(null);
  if (sessionMode === 'identity' && !identityRef.current) {
    identityRef.current = createIdentitySessionBinding();
  }
  const identity = identityRef.current;
  const isIdentityBound = identity !== null;

  const logger = useCallback((message: string, err?: unknown) => {
    if (__DEV__) {
      loggerUtil.warn(message, { component: 'OxyContext' }, err);
    }
  }, []);

  // Server-authoritative device session client. Built ONCE per `oxyServices`
  // instance. Device-scoped sockets connect with deviceId+deviceSecret when no
  // bearer is planted yet, so cross-origin apps sync via `session_state`.
  const sessionClientPairRef = useRef<ReturnType<typeof createSessionClient> | null>(null);
  if (!sessionClientPairRef.current) {
    sessionClientPairRef.current = createSessionClient(
      oxyServices,
      (origin) => {
        // Erase the DURABLE device credential only on a `request`-origin verdict
        // (a REST sign-out / revocation). A `push`-origin empty state is a socket
        // broadcast that may be a transient reconnect artifact — clearing the
        // credential on it would strand the user signed out with no way back, so
        // we clear only the local UI session and keep the credential (a dead one
        // re-mints to `no_active_session` and resolves signed-out on next boot).
        if (origin === 'request') {
          clearPersistedAuthSafe(authStore, logger);
        }
        void clearSessionStateRef.current().catch((clearError) => {
          logger('Failed to clear local state on remote sign-out', clearError);
        });
      },
      // `null` for every account-mode provider — identical to omitting the
      // option — and the pinned account id once an identity-bound provider has
      // resolved its pin. Read through the ref so the resolver stays stable for
      // the client's lifetime while still seeing later resolutions.
      () => identityRef.current?.getPinnedAccountId() ?? null,
    );
  }
  const { client: sessionClient, host: sessionClientHost } = sessionClientPairRef.current;

  // ── The runtime ──────────────────────────────────────────────────────────
  // One owner for the session facts (ADR 0004), built ONCE and never rebuilt,
  // so the context value below can hand out a reference that never changes.
  //
  // Its three callbacks reach forward through refs because the collaborators
  // they need — the storage-backed teardown, the account-graph refresh — are
  // hooks declared after it. Latching the runtime here rather than after them
  // is deliberate: a runtime rebuilt mid-flight would drop its `SessionClient`
  // subscription and every subscriber with it.
  const clearSessionStateRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const saveSessionIdsRef = useRef<(sessionIds: string[]) => void>(() => undefined);
  const subjectChangeRef = useRef<(transition: SubjectTransition) => void>(() => undefined);
  const reestablishRef = useRef<(binding: IdentitySessionBinding, revision: number) => void>(
    () => undefined,
  );

  const runtimeRef = useRef<OxyRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createOxyRuntime({
      oxyServices,
      sessionClient,
      sessionClientHost,
      identity,
      onSubjectChange: (transition) => subjectChangeRef.current(transition),
      onDeviceEmpty: () => clearSessionStateRef.current(),
      onSessionsProjected: (sessionIds) => saveSessionIdsRef.current(sessionIds),
      onIdentityUnbound: (binding, revision) => reestablishRef.current(binding, revision),
      logger,
    });
  }
  const runtime = runtimeRef.current;

  const snapshot = useRuntimeSnapshot(runtime);
  const {
    account: user,
    sessions,
    activeSessionId,
    isLoading,
    tokenReady,
    hasAccessToken,
    authResolved,
  } = snapshot;
  const isAuthenticated = user !== null;
  const error = snapshot.error?.message ?? null;

  const [initialized, setInitialized] = useState(false);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);

  // Project the runtime onto `useAuthStore`, which a dozen out-of-band callers
  // (mutation success handlers, cache helpers, the Commons app) still read the
  // signed-in user through. It is a projection, not a second store.
  useEffect(() => bindAuthStoreToRuntime(runtime), [runtime]);

  useEffect(() => runtime.start(), [runtime]);

  // Keep the shared `oxyClient` singleton's token store in lockstep with the
  // session owned by THIS provider's instance (many apps build API clients
  // against the exported singleton while passing only `baseURL` here). Skipped
  // when the app passed the singleton itself as `oxyServices`.
  useEffect(() => {
    if (oxyServices === oxyClient) {
      return;
    }
    const applyToSingleton = (accessToken: string | null) => {
      if (accessToken) {
        oxyClient.setTokens(accessToken);
      } else {
        oxyClient.clearTokens();
      }
    };
    applyToSingleton(oxyServices.getAccessToken());
    return oxyServices.onTokensChanged(applyToSingleton);
  }, [oxyServices]);

  const storageKeys = useMemo(() => getStorageKeys(storageKeyPrefix), [storageKeyPrefix]);

  const clientId = useMemo(() => {
    const trimmed = clientIdProp?.trim();
    return trimmed ? trimmed : null;
  }, [clientIdProp]);

  // Local display/bookkeeping storage (session id list, language). Distinct
  // from `authStore` (the durable credential blob). Exposed as an awaitable so
  // a persistence write is never dropped because it raced storage init.
  const storageRef = useRef<StorageInterface | null>(null);
  const [storage, setStorage] = useState<StorageInterface | null>(null);
  const buildStorageDeferred = () => {
    let resolve: (storage: StorageInterface) => void = () => undefined;
    const promise = new Promise<StorageInterface>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const storageReadyRef = useRef<ReturnType<typeof buildStorageDeferred> | null>(null);
  if (storageReadyRef.current === null) {
    storageReadyRef.current = buildStorageDeferred();
  }
  const storageReady = storageReadyRef.current;

  useEffect(() => {
    let mounted = true;
    createPlatformStorage()
      .then((storageInstance) => {
        storageRef.current = storageInstance;
        storageReady.resolve(storageInstance);
        if (mounted) {
          setStorage(storageInstance);
          runtime.setStorageReady(true);
        }
      })
      .catch((err) => {
        if (mounted) {
          logger('Failed to initialize storage', err);
          onError?.({ message: 'Failed to initialize storage', code: 'STORAGE_INIT_ERROR', status: 500 });
        }
      });
    return () => {
      mounted = false;
    };
  }, [logger, onError, runtime, storageReady]);

  const {
    currentLanguage,
    languages: currentLanguages,
    metadata: currentLanguageMetadata,
    languageName: currentLanguageName,
    nativeLanguageName: currentNativeLanguageName,
    setLanguage,
  } = useLanguageManagement({
    storage,
    languageKey: storageKeys.language,
    user,
    onError,
    logger,
  });

  const queryClient = useQueryClient();

  const {
    saveSessionIds,
    switchSession,
    clearSessionState,
    saveActiveSessionId,
  } = useSessionManagement({
    oxyServices,
    runtime,
    storage,
    storageKeyPrefix,
    onAuthStateChange,
    onError,
    setAuthError: (message) => runtime.setError(message),
    logger,
    queryClient,
  });

  clearSessionStateRef.current = clearSessionState;
  saveSessionIdsRef.current = saveSessionIds;

  const onAuthStateChangeRef = useRef(onAuthStateChange);
  onAuthStateChangeRef.current = onAuthStateChange;

  // Flip the auth-resolution gate the moment a session commits or the boot
  // concludes signed out. Idempotent + monotonic, enforced by the runtime.
  const markAuthResolved = useCallback(() => {
    runtime.markAuthResolved();
  }, [runtime]);
  const markAuthResolvedRef = useRef(markAuthResolved);
  markAuthResolvedRef.current = markAuthResolved;

  const setTokenReady = useCallback(
    (ready: boolean) => {
      runtime.setTokenReady(ready);
    },
    [runtime],
  );

  // Re-establishment lane for an identity-bound provider whose pin is missing or
  // whose pinned account is no longer part of this device's session set (another
  // app signed it out, or the device was re-provisioned). Adopting whichever
  // account the device is currently switched to is exactly the drift
  // `sessionMode: 'identity'` exists to prevent, so the only correct answer is to
  // re-derive the session from the local identity key.
  //
  // Bounded on purpose: at most ONE attempt per applied device revision, and
  // never two concurrently — a repeated failure (locked keychain, offline, no
  // local identity) must never spin a sign-in loop against the server. Nothing
  // awaits it, so it can never deadlock against the projection that triggers it;
  // the `bootstrap()` below re-applies device state, whose notify re-runs the
  // projection with the pin now resolved.
  const identityEstablishRef = useRef<{ revision: number | null; inFlight: boolean }>({
    revision: null,
    inFlight: false,
  });

  const reestablishIdentitySession = useCallback(
    (binding: IdentitySessionBinding, revision: number): void => {
      const tracker = identityEstablishRef.current;
      if (tracker.inFlight || tracker.revision === revision) {
        return;
      }
      tracker.revision = revision;
      tracker.inFlight = true;
      void (async () => {
        const established = await establishIdentitySession({
          oxy: oxyServices,
          store: authStore,
          binding: binding.binding,
        });
        if (!established) {
          return;
        }
        // The verify wrote a fresh pin; adopt it before re-reading device state
        // so the notify that follows projects against the new binding.
        await binding.refreshPinnedAccountId();
        await sessionClient.bootstrap();
      })()
        .catch((establishError) => {
          logger('Failed to re-establish the identity-bound session', establishError);
        })
        .finally(() => {
          tracker.inFlight = false;
        });
    },
    [oxyServices, authStore, sessionClient, logger],
  );
  reestablishRef.current = reestablishIdentitySession;

  /**
   * Project the server-authoritative device state onto the runtime.
   *
   * The projection itself lives in the runtime; this is the awaitable handle
   * the commit/logout/reconnect paths already had. It is stable, because the
   * runtime is.
   */
  const syncFromClient = useCallback((): Promise<void> => runtime.reconcileFromClient(), [runtime]);
  const syncFromClientRef = useRef(syncFromClient);
  syncFromClientRef.current = syncFromClient;

  const syncDeviceCredentialToHost = useCallback(async (): Promise<void> => {
    const cred = await loadPersistedDeviceCredential(authStore);
    sessionClientHost.setDeviceCredential(cred);
  }, [authStore, sessionClientHost]);

  const { signIn, logout, logoutAll } = useAuthOperations({
    oxyServices,
    store: authStore,
    storage,
    runtime,
    saveActiveSessionId,
    clearSessionState,
    switchSession,
    sessionClient,
    syncFromClient,
    onAuthStateChange,
    onError,
    logger,
    ...(identity
      ? {
          identityBinding: identity.binding,
          refreshPinnedAccountId: () => identity.refreshPinnedAccountId(),
        }
      : {}),
  });

  // "That wasn't me": repudiating a flagged sign-in IS revoking the device
  // session that just committed — the same server-authoritative
  // `sessionClient.signOut(...)` path `logout` uses, which also clears the
  // persisted device credential + local state when no sibling account remains.
  // No dedicated "report suspicious" API endpoint exists (or is needed).
  const revokeSuspiciousSignIn = useCallback(async (): Promise<void> => {
    await logout();
  }, [logout]);

  const clearAllAccountData = useCallback(async (): Promise<void> => {
    queryClient.clear();
    if (storage) {
      try {
        await clearQueryCache(storage);
      } catch (error) {
        logger('Failed to clear persisted query cache', error);
      }
    }
    await clearSessionState();
    // Explicit FULL wipe: also drop the persisted device credential so a reload
    // finds nothing to restore.
    await authStore.clear();
    oxyServices.clearCache();
  }, [queryClient, storage, clearSessionState, authStore, logger, oxyServices]);

  const { getDeviceSessions, logoutAllDeviceSessions, updateDeviceName } = useDeviceManagement({
    oxyServices,
    activeSessionId,
    onError,
    clearSessionState,
    logger,
  });


  // Token-change side effects: an invalidated bearer (HttpService clears tokens
  // on an unrecoverable 401 and emits `null`) must locally sign out an
  // authenticated user so `isAuthenticated` never lingers true with no token.
  // The persisted store is NOT cleared here — the refresh handler already
  // cleared it if the family was revoked; a transient null leaves it intact so a
  // later reload can still restore.
  const clearingInvalidTokenRef = useRef(false);
  useEffect(() => {
    const handleTokenChange = (accessToken: string | null) => {
      runtime.setHasAccessToken(Boolean(accessToken));
      if (accessToken) {
        runtime.setTokenReady(true);
        if (sessionClient.getState()?.accounts.length) {
          void syncFromClientRef.current();
        }
        return;
      }
      if (runtime.getSnapshot().account !== null) {
        runtime.setTokenReady(false);
        if (clearingInvalidTokenRef.current) {
          return;
        }
        clearingInvalidTokenRef.current = true;
        clearSessionStateRef.current()
          .catch((clearError) => {
            logger('Failed to clear invalidated auth session', clearError);
          })
          .finally(() => {
            clearingInvalidTokenRef.current = false;
            if (runtime.getSnapshot().authResolved) {
              runtime.setTokenReady(true);
            }
          });
        return;
      }
      if (runtime.getSnapshot().authResolved) {
        runtime.setTokenReady(true);
      }
    };
    handleTokenChange(oxyServices.getAccessToken());
    return oxyServices.onTokensChanged(handleTokenChange);
  }, [logger, oxyServices, runtime, sessionClient]);

  // Unified in-session refresh (SDK-owned; every RP inherits it). Installs the
  // ONE core refresh handler (re-mint from the persisted zero-cookie device
  // credential via `POST /session/device/token`) plus the proactive scheduler
  // that refreshes ~60s before expiry and on tab-focus. Replaces the deleted
  // services-local `inSessionTokenRefresh` module.
  // An identity binding turns every re-mint pinned: it targets the pinned
  // account instead of the device's active one, and its recovery arm becomes the
  // PRIMARY-key identity sign-in rather than the cross-app shared keychain.
  useEffect(() => {
    const dispose = installAuthRefreshHandler({
      oxy: oxyServices,
      store: authStore,
      ...(identity ? { identity: identity.binding } : {}),
    });
    const scheduler = startTokenRefreshScheduler(oxyServices);
    return () => {
      scheduler.dispose();
      dispose();
    };
  }, [oxyServices, authStore, identity]);

  // ── Session commit funnel ────────────────────────────────────────────────
  // The single place a session becomes committed: plant tokens, persist the
  // zero-cookie device credential (`deviceId` + `deviceSecret`), register the
  // account into the server-authoritative device set, and hydrate the full user.
  // Used by the QR device flow (`handleWebSession`), password sign-in, 2FA
  // completion, and the cold boot.
  const commitSession = useCallback(
    async (input: CommitInput, options: { activate: boolean }): Promise<void> => {
      if (input.accessToken) {
        oxyServices.setTokens(input.accessToken);
      }

      // Persist the durable blob when the zero-cookie device credential is present.
      if (input.deviceId && input.deviceSecret) {
        try {
          const prior = await authStore.load();
          const next: PersistedAuthState = {
            sessionId: input.sessionId || prior?.sessionId || '',
            userId: input.userId || prior?.userId || '',
            deviceId: input.deviceId,
            deviceSecret: input.deviceSecret,
            ...(input.accessToken ? { accessToken: input.accessToken } : {}),
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          };
          await authStore.save(next);
          sessionClientHost.setDeviceCredential({
            deviceId: input.deviceId,
            deviceSecret: input.deviceSecret,
          });
        } catch (persistError) {
          logger('Failed to persist auth state on commit', persistError);
        }
      }

      // Fast local mirror so the UI updates before the server round-trip; the
      // SessionClient projection below overwrites it with server truth. Batched
      // so the mirror and the active id land in ONE transition — unbatched, a
      // subscriber woken between them would see the new session list still
      // pointing at the previous active id.
      if (input.userId) {
        const now = new Date();
        runtime.batch(() => {
          runtime.mergeSessions(
            [
              {
                sessionId: input.sessionId,
                deviceId: input.deviceId ?? '',
                expiresAt: input.expiresAt || new Date(now.getTime() + DEFAULT_SESSION_VALIDITY_MS).toISOString(),
                lastActive: now.toISOString(),
                userId: input.userId,
                isCurrent: true,
              },
            ],
            { merge: true },
          );
          runtime.setActiveSessionId(input.sessionId);
        });
      }

      // Register into the device set, hydrate the full user, and flip the
      // auth-resolution gate. A deliberate sign-in ACTIVATES the account and
      // BLOCKS on the reconcile (register + socket + sessions projection) before
      // resolving — unchanged ordering. The cold boot resolves auth from the
      // profile fetch FIRST and reconciles the device set in the background, so
      // first paint is not held behind those extra round-trips. Reconcile is
      // best-effort — a failure never fails the sign-in (cold boot re-registers
      // on the next load).
      await commitDeviceSetAndResolve({
        activate: options.activate,
        userId: input.userId,
        fallbackUser: (input.user as unknown as User) ?? null,
        registerAndActivate: (userId) => sessionClient.registerAndActivate(userId),
        addCurrentAccount: () => sessionClient.addCurrentAccount(),
        startSocket: () => sessionClient.start(),
        syncFromClient,
        getCurrentUser: () => oxyServices.getCurrentUser(),
        loginSuccess: (fullUser) => runtime.setAccount(fullUser),
        onAuthStateChange: onAuthStateChangeRef.current,
        markAuthResolved: markAuthResolvedRef.current,
      });
    },
    [oxyServices, authStore, runtime, sessionClient, sessionClientHost, syncFromClient, logger],
  );
  const commitSessionRef = useRef(commitSession);
  commitSessionRef.current = commitSession;

  // Public `handleWebSession`: commit a session from the QR device flow. It is a
  // deliberate sign-in on THIS device, so it activates the account.
  const handleWebSession = useCallback(
    async (session: SessionLoginResponse): Promise<void> => {
      if (!session?.user || !session?.sessionId || !session.accessToken) {
        throw new Error('Session response did not include a usable session');
      }
      await commitSession(
        {
          sessionId: session.sessionId,
          accessToken: session.accessToken,
          deviceSecret: session.deviceSecret,
          deviceId: session.deviceId,
          expiresAt: session.expiresAt,
          userId: session.user.id,
          user: session.user,
        },
        { activate: true },
      );
    },
    [commitSession],
  );

  // ── Web third-party OAuth sign-in ──────────────────────────────────────────
  // The shared operation `OxySignInButton` (and any RP-owned button) delegates
  // to, so no consumer ever writes popup listeners or a token exchange. The
  // transport picks popup vs redirect from `webAuthMode`; both lanes land on the
  // SAME completion path (`completeOAuthCode`) and the same commit funnel here.
  const startWebOAuthSignInForContext = useCallback(
    (options: StartWebOAuthSignInOptions): Promise<WebOAuthSignInResult> =>
      startWebOAuthSignIn(
        {
          mode: webAuthMode,
          oxyServices,
          clientId,
          authorizeBaseUrl,
          identityBound: isIdentityBound,
          commitSession: (input) => commitSessionRef.current(input, { activate: true }),
        },
        options,
      ),
    [webAuthMode, oxyServices, clientId, authorizeBaseUrl, isIdentityBound],
  );

  // ── Unified account dialog ─────────────────────────────────────────────────
  // The single account-chooser + sign-in surface. Built ONCE per provider mount
  // and bound to the live `oxyServices` + `sessionClient` + this provider's
  // sign-in commit funnel, threaded through a ref so the controller keeps a
  // STABLE commit callback (rebuilding the controller on every commit-identity
  // change would drop its subscription + state).
  const handleWebSessionRef = useRef(handleWebSession);
  handleWebSessionRef.current = handleWebSession;

  // The live AccountDialog surface (a stacked Bloom surface), while open — the
  // SINGLE source of truth for "is the account dialog open". Held so
  // `openAccountDialog` can no-op when already open and `closeAccountDialog` /
  // `onSignedIn` can dismiss it. Its present→settle lifecycle is what drives the
  // reactive `accountDialogOpen` mirror below: presenting flips it true, the
  // surface settling (`result.finally`) flips it false — no other write site.
  const accountDialogSurfaceRef = useRef<SurfaceInstance<'AccountDialog'> | null>(null);

  // When the account dialog is shown by MORPHING an already-open route surface
  // (e.g. ManageAccount → the account switcher) it is pushed as a frame ONTO that
  // surface rather than presented as its own. This holds that host surface so the
  // close path can pop the AccountDialog frame back to it. `null` when the dialog
  // is its OWN detached surface (opened cold, with no surface underneath).
  const accountDialogHostRef = useRef<TrackedSurface | null>(null);

  // The single teardown for the account dialog wherever it lives: pop the morphed
  // frame back to its host surface (reshaping Manage ← switcher), or dismiss the
  // detached surface (whose settle then flips `accountDialogOpen`). Reads only
  // stable refs + `setAccountDialogOpen`, so its identity never changes.
  const dismissAccountDialogSurface = useCallback((): void => {
    const host = accountDialogHostRef.current;
    if (host) {
      accountDialogHostRef.current = null;
      setAccountDialogOpen(false);
      host.goBack();
      return;
    }
    accountDialogSurfaceRef.current?.dismiss();
  }, []);

  // Never built while identity-bound: the dialog exists to CHOOSE an account,
  // and an identity-bound client has exactly one — the owner of the local
  // identity key. Leaving it `null` (the same shape consumers see with no
  // provider mounted) keeps its QR/polling machinery off entirely instead of
  // relying on UI-level filtering to hide it.
  const accountDialogControllerRef = useRef<AccountDialogController | null>(null);
  if (!isIdentityBound && !accountDialogControllerRef.current) {
    accountDialogControllerRef.current = createAccountDialogController({
      oxyServices,
      sessionClient,
      clientId,
      // Same statically-injected `io` as the SessionClient: gives the QR flow an
      // instant `/auth-session` `auth_update` wake instead of a slow poll.
      socketFactory: io,
      commitSession: (session) => handleWebSessionRef.current(session),
      onSignedIn: () => {
        // Close the dialog: pop the morphed frame back to its host surface, or
        // dismiss the detached surface (whose settle flips `accountDialogOpen`).
        dismissAccountDialogSurface();
      },
      openUrl: (url) => {
        if (isWebBrowser()) {
          redirectToAuthorize(url);
          return;
        }
        void Linking.openURL(url);
      },
      // Native-only probe so the controller can detect an installed Commons and
      // deep-link straight into its approve screen (keeping the QR/polling live
      // as fallback). `undefined` on web mirrors the `openUrl` split — the
      // controller short-circuits, so `redirectToAuthorize` never runs for the
      // `oxycommons://` payload.
      canOpenApp: isWebBrowser() ? undefined : (url) => Linking.canOpenURL(url),
      // Web-only: lets `startPasskeyHubSignIn` open the auth.oxy.so passkey hub
      // popup (b2) for a non-Oxy origin. `undefined` on native — there is no
      // popup concept there, and off-origin passkey sign-in isn't reachable
      // (Commons owns the native flow).
      openPopup: isWebBrowser() ? openPasskeyHubPopup : undefined,
      // Which surface a sign-in starts from — a FACT only this consumer can
      // supply (headless core never touches a platform global). It decides
      // whether automatic delivery may take the same-device Commons deep link;
      // without it the controller stays `'unknown'` and that route never fires.
      platform: resolveDeliveryPlatform(),
    });
  }
  const accountDialogController = accountDialogControllerRef.current;

  const openAccountDialog = useCallback((view?: AccountDialogView): void => {
    if (isIdentityBound) {
      // No controller was built, and there is nothing to choose: this app's user
      // is fixed to the owner of the local identity key.
      if (__DEV__) {
        loggerUtil.warn(
          'openAccountDialog ignored: the session is identity-bound (sessionMode: "identity")',
          { component: 'OxyContext', method: 'openAccountDialog' },
        );
      }
      return;
    }
    const nextView = view ?? 'accounts';
    accountDialogControllerRef.current?.setView(nextView);

    // Its own detached surface is already open → just re-point the view above.
    if (accountDialogSurfaceRef.current) {
      setAccountDialogOpen(true);
      return;
    }

    // When a route surface (e.g. ManageAccount) is already open, MORPH it in
    // place: push the AccountDialog as a frame ONTO that surface, so the panel
    // reshapes from that surface to the switcher and a back returns to it. With no
    // surface open (opened cold from a sign-in button), present the dialog as its
    // OWN detached surface — kept OUT of the `showBottomSheet` route-surface
    // lineage so closing the bottom-sheet session never touches it and vice-versa.
    // `navigate` is idempotent for the top frame (it replaces rather than
    // duplicates), so calling this while already morphed in just re-points the
    // view, and calling it after a back re-pushes the frame — no stale guard.
    const host = topRouteSurface();
    if (host) {
      accountDialogHostRef.current = host;
      host.navigate('AccountDialog', { initialView: nextView });
      setAccountDialogOpen(true);
      return;
    }

    const instance = presentDetached(
      'AccountDialog',
      { initialView: nextView },
      { placement: { base: 'bottom', md: 'center' }, dismissOnBackdrop: false, maxWidth: 420 },
    );
    accountDialogSurfaceRef.current = instance;
    // The surface settling is the ONE place `accountDialogOpen` flips false for
    // the detached path — covering every dismiss (close button, `onSignedIn`,
    // programmatic `closeAccountDialog`, host unmount). The morphed path clears
    // its own state in `dismissAccountDialogSurface`.
    instance.result.finally(() => {
      if (accountDialogSurfaceRef.current === instance) {
        accountDialogSurfaceRef.current = null;
        setAccountDialogOpen(false);
      }
    });
    setAccountDialogOpen(true);
  }, [isIdentityBound]);

  const closeAccountDialog = useCallback((): void => {
    accountDialogControllerRef.current?.cancelSignIn();
    dismissAccountDialogSurface();
  }, [dismissAccountDialogSurface]);

  // Start driving the dialog on mount; tear it down on unmount.
  useEffect(() => {
    const controller = accountDialogControllerRef.current;
    controller?.start();
    return () => controller?.destroy();
  }, []);

  // Expose the live open/close controls to the imperative manager so
  // Imperative `openAccountDialog('signin')` (and app-level sign-in handlers) works.
  useEffect(
    () => registerAccountDialogControls({ open: openAccountDialog, close: closeAccountDialog }),
    [openAccountDialog, closeAccountDialog],
  );

  // Broadcast visibility so `OxySignInButton`'s "Signing in…" affordance stays
  // accurate regardless of what opened or dismissed the dialog.
  useEffect(() => {
    notifyAccountDialogVisibility(accountDialogOpen);
  }, [accountDialogOpen]);

  // ── Passkey (WebAuthn) ─────────────────────────────────────────────────────
  // Web-only sign-in / registration via the browser WebAuthn ceremony. The fixed
  // `options → ceremony → verify → commit` ordering lives in the pure
  // `passkeyFlow` helpers (deps-injected, unit-tested); these wrappers supply the
  // real deps (core `webauthn*` methods, the platform ceremony client, and the
  // `commitSession` funnel). All three GATE on `isPasskeySupported()` so a native
  // / unsupported surface throws loudly instead of stalling in a ceremony.

  // Passkey sign-in. No `username` → usernameless (discoverable) flow. With a
  // `username` → username-first: the server scopes `allowCredentials` to that
  // user's passkeys so a non-discoverable hardware key (U2F/security key) can
  // be selected.
  const signInWithPasskey = useCallback(
    async (opts?: { username?: string; deviceName?: string; deviceFingerprint?: string }): Promise<void> => {
      const persisted = await authStore.load();
      await runPasskeyLogin({
        isSupported: isPasskeySupported,
        getLoginOptions: (username) => oxyServices.webauthnLoginOptions(username),
        runCeremony: runAuthenticationCeremony,
        loginVerify: (response, envelope) => oxyServices.webauthnLoginVerify(response, envelope),
        commit: (input) => commitSession(input, { activate: true }),
        username: opts?.username,
        deviceId: persisted?.deviceId,
        deviceName: opts?.deviceName,
        deviceFingerprint: opts?.deviceFingerprint,
      });
    },
    [oxyServices, authStore, commitSession],
  );

  // Create a brand-new account whose first auth method is a passkey.
  const registerWithPasskey = useCallback(
    async (params: { username: string; deviceName?: string }): Promise<void> => {
      await runPasskeyRegister({
        isSupported: isPasskeySupported,
        getRegisterOptions: (username) => oxyServices.webauthnRegisterOptions(username),
        runCeremony: runRegistrationCeremony,
        registerVerify: (response, envelope) => oxyServices.webauthnRegisterVerify(response, envelope),
        commit: (input) => commitSession(input, { activate: true }),
        username: params.username,
        deviceName: params.deviceName,
      });
    },
    [oxyServices, commitSession],
  );

  // Add a passkey to the already-signed-in account (bearer present). No new
  // session is committed — just refresh the linked auth-methods list.
  const addPasskey = useCallback(
    async (params?: { deviceName?: string }): Promise<void> => {
      await runPasskeyAdd({
        isSupported: isPasskeySupported,
        getRegisterOptions: () => oxyServices.webauthnRegisterOptions(),
        runCeremony: runRegistrationCeremony,
        registerVerify: (response, envelope) => oxyServices.webauthnRegisterVerify(response, envelope),
        onLinked: () => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.authMethods.all });
        },
        deviceName: params?.deviceName,
      });
    },
    [oxyServices, queryClient],
  );

  // Remove a passkey from the already-signed-in account by credential id. Not a
  // ceremony — a plain unlink — so it needs no `isPasskeySupported` gate; it just
  // refreshes the linked auth-methods list on success.
  const removePasskey = useCallback(
    async (credentialId: string): Promise<void> => {
      await oxyServices.removePasskey(credentialId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMethods.all });
    },
    [oxyServices, queryClient],
  );

  // ── Cold boot ────────────────────────────────────────────────────────────
  // Device-first session restore via `runProviderColdBoot` (see boot/runProviderColdBoot.ts).
  const runColdBoot = useCallback(async (): Promise<void> => {
    // Resolve the pin BEFORE any boot lane runs: `getPinnedAccountId()` is a
    // SYNCHRONOUS read on `SessionClient`'s apply path, and a stale `null` there
    // would let a pinned client behave like an account-mode one for the first
    // state it applies (including re-electing the device's active account).
    if (identity) {
      await identity.ensurePinnedAccountId();
    }
    await runProviderColdBoot({
      oxyServices,
      authStore,
      clientId: clientIdProp,
      authRedirectUri,
      sessionMode,
      identity: identity?.binding,
      sessionClient,
      syncDeviceCredentialToHost,
      commitSession: (input, options) => commitSessionRef.current(input, options),
      markAuthResolved: () => markAuthResolvedRef.current(),
      setTokenReady,
    });
    // The boot may have (re-)established the identity session or cleared a pin
    // whose key no longer exists, so re-resolve rather than trusting the memo
    // taken before it ran.
    if (identity) {
      await identity.refreshPinnedAccountId();
    }
  }, [
    oxyServices,
    authStore,
    clientIdProp,
    authRedirectUri,
    sessionMode,
    identity,
    syncDeviceCredentialToHost,
    sessionClient,
    setTokenReady,
  ]);

  useEffect(() => {
    if (initialized) {
      return;
    }
    if (!storage) {
      return;
    }
    setInitialized(true);
    runColdBoot().catch((error) => {
      if (__DEV__) {
        logger('Cold boot failed', error);
      }
    });
  }, [runColdBoot, storage, initialized, logger]);

  // Reconcile device state when the tab returns to foreground (background tabs may
  // miss socket pushes or have stale bearer tokens).
  useEffect(() => {
    if (!isWebBrowser()) return;
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      const reconcile = async (): Promise<void> => {
        if (!oxyServices.getAccessToken() && sessionClientHost.getDeviceCredential()) {
          // Route through the ONE shared single-flight the scheduler/preflight/401
          // use — never a private mint lane — so a tab-focus reconcile can't
          // double-rotate the device secret against them.
          await oxyServices.httpService.refreshAccessToken('preflight');
        }
        if (!oxyServices.getAccessToken() && !sessionClientHost.getDeviceCredential()) {
          return;
        }
        await sessionClient.bootstrap();
        await syncFromClient();
      };
      void reconcile().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [oxyServices, sessionClient, sessionClientHost, syncFromClient]);

  // Reconnect heal: when connectivity transitions offline→online while there is
  // no live access token but a persisted device credential exists, re-mint ONCE
  // through the SAME shared single-flight lane the scheduler / tab-focus
  // reconcile / 401 path use — never a private mint lane, so this can't
  // double-rotate the device secret against them. A device that cold-booted
  // OFFLINE skipped the network mint step, so its session is otherwise only
  // recovered by the next scheduled re-mint; healing on the reconnect edge makes
  // recovery immediate. `onlineManager` is fed by OxyProvider's existing NetInfo
  // (native) / `navigator.onLine` (web) listener, so this reuses the one
  // connectivity signal instead of opening a second NetInfo subscription. Works
  // on native and web alike.
  useEffect(() => {
    // Seed from the current verdict so the first callback heals only on a
    // genuine offline→online edge, never an initial subscribe fan-out.
    let previousOnline = onlineManager.isOnline();
    return onlineManager.subscribe((online: boolean) => {
      const wasOffline = previousOnline === false;
      previousOnline = online;
      if (!online || !wasOffline) {
        return;
      }
      void (async () => {
        if (oxyServices.getAccessToken() || !sessionClientHost.getDeviceCredential()) {
          return;
        }
        await oxyServices.httpService.refreshAccessToken('preflight');
        if (!oxyServices.getAccessToken()) {
          return;
        }
        await sessionClient.bootstrap();
        await syncFromClient();
      })().catch(() => undefined);
    });
  }, [oxyServices, sessionClient, sessionClientHost, syncFromClient]);

  // Exposed `refreshSessions`: re-bootstrap the server-authoritative device
  // state and reproject — the manual counterpart to the realtime socket.
  const refreshSessionsForContext = useCallback(async (): Promise<void> => {
    await sessionClient.bootstrap();
    await syncFromClient();
  }, [sessionClient, syncFromClient]);

  // Exposed `switchSession`: route through the server-authoritative
  // `SessionClient`. Resolve the target account from the current device state,
  // ask the server to switch, reproject, and return the now-active user.
  //
  // Identity-bound providers reject: this is the session-keyed twin of
  // `switchToAccount`, so leaving it live would be a bypass around the same rule.
  const switchSessionForContext = useCallback(
    async (sessionId: string): Promise<User> => {
      if (isIdentityBound) {
        throw new IdentityBoundSessionError('switchSession');
      }
      const targetAccountId = sessionClient
        .getState()
        ?.accounts.find((account) => account.sessionId === sessionId)?.accountId;
      if (!targetAccountId) {
        throw new Error(`No device account found for session "${sessionId}"`);
      }
      await sessionClient.switchAccount(targetAccountId);
      await syncFromClient();
      const activeUser = runtime.getSnapshot().account;
      if (!activeUser) {
        throw new Error('Active account profile could not be resolved after switch');
      }
      return activeUser;
    },
    [isIdentityBound, runtime, sessionClient, syncFromClient],
  );

  // Thin passthroughs to the platform-agnostic KeyManager. NOTE: both now THROW
  // `IdentityUnavailableError` (from `@oxyhq/core`) when identity storage is
  // locked/unreadable, instead of flattening that into `false`/`null`. We keep
  // the signatures and deliberately let the typed error PROPAGATE to the caller
  // — a locked keychain must never be misreported as "no identity". `hasIdentity`
  // still resolves `false` and `getPublicKey` still resolves `null` for a genuine
  // absence.
  const hasIdentity = useCallback(async (): Promise<boolean> => KeyManager.hasIdentity(), []);
  const getPublicKey = useCallback(async (): Promise<string | null> => KeyManager.getPublicKey(), []);

  const showBottomSheetForContext = useCallback(
    (screenOrConfig: RouteName | { screen: RouteName; props?: Record<string, unknown> }) => {
      globalShowBottomSheet(screenOrConfig);
    },
    [],
  );

  const { openAvatarPicker } = useAvatarPicker({
    oxyServices,
    currentLanguage,
    activeSessionId,
    queryClient,
  });

  const { accounts, refreshAccounts, switchToAccount, createAccount: createAccountFn } = useOxyAccountGraph({
    isAuthenticated,
    tokenReady,
    initialized,
    identityBound: isIdentityBound,
    oxyServices,
    sessionClient,
    syncFromClient,
    commitSession,
    accountDialogControllerRef,
    clearSessionStateRef,
  });

  // The account-scoped cache reset, run by the runtime BETWEEN committing the
  // new subject's bearer and waking anybody (ADR 0002). It used to trail the two
  // branches of `switchToAccount`, which meant a switch pushed over the socket
  // by another app on this device got none of it: the follow stores, the scoped
  // media URLs and every warm query stayed on the previous subject until
  // something happened to refetch.
  //
  // An initial sign-in is deliberately exempt. There is nothing account-scoped
  // cached before the first account, so invalidating everything there would only
  // buy a refetch storm at first paint.
  const handleSubjectChange = useCallback(
    ({ previous, next }: SubjectTransition): void => {
      if (previous === null) {
        return;
      }
      resetSessionScopedStores();
      if (next === null) {
        // A sign-out: `clearSessionState` owns the rest of the teardown, and
        // invalidating a cache we are about to clear would only refetch as the
        // bearer disappears.
        return;
      }
      // Scoped media tokens are per-viewer — drop any cached URLs immediately so
      // `keepPreviousData`-style placeholders cannot flash the prior account's
      // private thumbnails while the new bearer mint lands.
      queryClient.removeQueries({ queryKey: [ASSET_DOWNLOAD_URLS_QUERY_KEY] });
      queryClient.invalidateQueries();
      void refreshAccounts();
    },
    [queryClient, refreshAccounts],
  );
  subjectChangeRef.current = handleSubjectChange;

  const canUsePrivateApi = authResolved && isAuthenticated && tokenReady && hasAccessToken;
  const isPrivateApiPending = !authResolved || (isAuthenticated && (!tokenReady || !hasAccessToken));

  // Keep the native background credential in step with this session, so native
  // background code (a widget worker) can authenticate with no JS runtime. Inert
  // unless the app opted in. Placed AFTER `canUsePrivateApi` because provisioning
  // needs a bearer, and keyed on the signed-in account so a sign-out or an
  // account switch revokes the credential before anything else happens.
  useBackgroundSessionSync({
    enabled: backgroundSession,
    oxyServices,
    userId: user?.id ?? null,
    canUsePrivateApi,
  });

  const contextValue: OxyContextState = useMemo(
    () => ({
      user,
      sessions,
      activeSessionId,
      isAuthenticated,
      isLoading,
      isTokenReady: tokenReady,
      hasAccessToken,
      canUsePrivateApi,
      isPrivateApiPending,
      isAuthResolved: authResolved,
      isStorageReady: snapshot.storageReady,
      sessionMode: isIdentityBound ? 'identity' : 'account',
      webAuthMode,
      error,
      currentLanguage,
      currentLanguages,
      currentLanguageMetadata,
      currentLanguageName,
      currentNativeLanguageName,
      hasIdentity,
      getPublicKey,
      signIn,
      signInWithPasskey,
      registerWithPasskey,
      addPasskey,
      removePasskey,
      revokeSuspiciousSignIn,
      handleWebSession,
      startWebOAuthSignIn: startWebOAuthSignInForContext,
      logout,
      logoutAll,
      switchSession: switchSessionForContext,
      removeSession: logout,
      refreshSessions: refreshSessionsForContext,
      setLanguage,
      getDeviceSessions,
      logoutAllDeviceSessions,
      updateDeviceName,
      clearSessionState,
      clearAllAccountData,
      storageKeyPrefix,
      clientId,
      oxyServices,
      sessionClient,
      useFollow,
      showBottomSheet: showBottomSheetForContext,
      openAvatarPicker,
      accountDialogController,
      isAccountDialogOpen: accountDialogOpen,
      openAccountDialog,
      closeAccountDialog,
      accounts,
      switchToAccount,
      refreshAccounts,
      createAccount: createAccountFn,
    }),
    [
      user,
      sessions,
      activeSessionId,
      isAuthenticated,
      isLoading,
      tokenReady,
      hasAccessToken,
      canUsePrivateApi,
      isPrivateApiPending,
      authResolved,
      snapshot.storageReady,
      isIdentityBound,
      webAuthMode,
      error,
      currentLanguage,
      currentLanguages,
      currentLanguageMetadata,
      currentLanguageName,
      currentNativeLanguageName,
      hasIdentity,
      getPublicKey,
      signIn,
      signInWithPasskey,
      registerWithPasskey,
      addPasskey,
      removePasskey,
      revokeSuspiciousSignIn,
      handleWebSession,
      startWebOAuthSignInForContext,
      logout,
      logoutAll,
      switchSessionForContext,
      refreshSessionsForContext,
      setLanguage,
      getDeviceSessions,
      logoutAllDeviceSessions,
      updateDeviceName,
      clearSessionState,
      clearAllAccountData,
      storageKeyPrefix,
      clientId,
      oxyServices,
      sessionClient,
      showBottomSheetForContext,
      openAvatarPicker,
      accountDialogController,
      accountDialogOpen,
      openAccountDialog,
      closeAccountDialog,
      accounts,
      switchToAccount,
      refreshAccounts,
      createAccountFn,
    ],
  );

  // Two contexts, deliberately. The inner one carries the wide compatibility
  // value every `useOxy()` consumer reads, rebuilt whenever any of its members
  // moves. The outer one carries the runtime reference, which never changes
  // identity — so `useActiveAccount()` and friends re-render on the fact they
  // selected and nothing else. Phase 8 retires the inner one.
  return (
    <OxyRuntimeHandleProvider value={runtime}>
      <OxyRuntimeContext.Provider value={contextValue}>{children}</OxyRuntimeContext.Provider>
    </OxyRuntimeHandleProvider>
  );
};

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
