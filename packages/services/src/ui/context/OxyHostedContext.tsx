/**
 * The provider's runtime on a platform that holds the Oxy session (ADR 0058
 * decision 1): OxyOS's Bloom host, Astro's verified pages.
 *
 * `OxyProvider` mounts this instead of `OxyRuntimeProvider` when, at mount, a
 * session host is registered (`@oxy.so/core/host`) and `sessionMode` is
 * `'account'`. The hooks and the context are the same; the session source is
 * the host:
 *
 *  - WIRED: the token (`session/hostSession.ts`), the account from the host's
 *    snapshot, every API namespace, `createLinkedClient`, the user socket
 *    (bearer only, `user:<id>`), the account cache, the language.
 *  - SKIPPED: the auth-state store (nothing persisted), every cold-boot lane,
 *    the OAuth return lane, the identity pin, `SessionClient` and the device
 *    directory, the switcher, `setDeviceCredentialProvider`, the browser bridge,
 *    the background credential, the account dialog's sign-in screens. Nothing
 *    here calls `/session/device/*`.
 *  - HANDED OVER: `signIn()`, `openAccountDialog()`, a switch and `logout()`
 *    call `host.request(...)` and change nothing themselves; the result comes
 *    back as a snapshot.
 *
 * A host with a contract this SDK does not know leaves the app signed out:
 * the platform holds the session and forbids a second credential.
 */
import type React from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { OxyServices, logger as loggerUtil } from '@oxy.so/core';
import type { AccountNode, CreateAccountInput, User } from '@oxy.so/core';
import type { OxyHostRequest, OxySessionHost } from '@oxy.so/core/host';
import type { AccountDialogView } from '@oxy.so/core/session';
import { createUserEventSocket, type UserEventSocket } from '@oxy.so/core/session';
import { useQueryClient } from '@tanstack/react-query';
import { installNativeAssetFiles } from '../utils/nativeAssetFiles';
import { hasKnownSubjectMismatch, useKnownBearerSubject } from '../hooks/useKnownBearerSubject';
import {
  createOxyRuntime,
  OxyRuntimeHandleProvider,
  useRuntimeSnapshot,
  type OxyRuntime,
  type RuntimeSessionClient,
  type SubjectTransition,
} from '../runtime';
import { bindAuthStoreToRuntime } from '../stores/authStore';
import { resetSessionScopedStores } from '../stores/resetSessionScopedStores';
import { ASSET_DOWNLOAD_URLS_QUERY_KEY } from '../hooks/useResolvedFileUrls';
import { clearQueryCache } from '../hooks/queryClient';
import {
  createAccountQueryPersistence,
  type AccountQueryPersistence,
} from '../hooks/accountQueryPersistence';
import { useEntryLink } from '../hooks/useEntryLink';
import { useLanguageManagement } from '../hooks/useLanguageManagement';
import { useAvatarPicker } from '../hooks/useAvatarPicker';
import { useFollow } from '../hooks/useFollow';
import {
  getStorageKeys,
  createMemoryStorage,
  createPlatformStorage,
  type StorageInterface,
} from '../utils/storageHelpers';
import type { RouteName } from '../navigation/routes';
import { showBottomSheet as globalShowBottomSheet } from '../navigation/bottomSheetManager';
import {
  registerAccountDialogControls,
  notifyAccountDialogVisibility,
} from '../navigation/accountDialogManager';
import { createHostSession, HostedSessionError, type HostSession } from '../session/hostSession';
import { AppAssertionProvider } from '../appAssertion/AppAssertionContext';
import type { LogoutResult, OxyContextState, OxyRuntimeProviderProps } from './oxyContextTypes';
import {
  OxyRuntimeContext,
  OxyAuthActionsContext,
  type OxyAuthActionsContextState,
} from './oxyRuntimeContext';

export interface OxyHostedRuntimeProviderProps
  extends Omit<OxyRuntimeProviderProps, 'sessionMode' | 'backgroundSession' | 'authStateStore'> {
  /**
   * What `getOxySessionHost()` found at mount: the host, or a host this SDK
   * cannot speak to (`unknownContract`), in which case the app runs signed out.
   */
  session: { host: OxySessionHost } | { unknownContract: true };
}

/** The device-session seam of the runtime, empty: a hosted app has no device. */
const NO_DEVICE: RuntimeSessionClient = {
  getState: () => null,
  getDirectory: () => null,
  subscribe: () => () => undefined,
  refreshDirectory: async () => undefined,
  activateContext: async () => {
    throw new HostedSessionError('activateContext');
  },
  signOutContext: async () => {
    throw new HostedSessionError('signOutContext');
  },
  signOutPrincipal: async () => {
    throw new HostedSessionError('signOutPrincipal');
  },
};
const NO_DEVICE_HOST = { setCurrentAccountId: () => undefined };

/**
 * Which of the platform's screens an `openAccountDialog(view)` asks for: its
 * sign-in when signed out; while signed in, every view of the dialog — the
 * switcher, "add an account", a sign-in for another account — is the
 * platform's account switch.
 */
function requestForDialog(signedIn: boolean): OxyHostRequest {
  return signedIn ? 'switch_account' : 'sign_in';
}

export const OxyHostedRuntimeProvider: React.FC<OxyHostedRuntimeProviderProps> = ({
  children,
  session,
  oxyServices: providedOxyServices,
  baseURL,
  authWebUrl,
  authRedirectUri,
  storageKeyPrefix = 'oxy_session',
  clientId: clientIdProp,
  webAuthMode = 'popup',
  legacyLanguageKeys,
  captureCampaignAttribution = false,
  platformStorage,
  accountQueries,
  onAuthStateChange,
  onError,
}) => {
  const oxyServicesRef = useRef<OxyServices | null>(null);
  if (!oxyServicesRef.current) {
    if (providedOxyServices) {
      oxyServicesRef.current = providedOxyServices;
    } else if (baseURL) {
      oxyServicesRef.current = new OxyServices({
        baseURL,
        authWebUrl,
        authRedirectUri,
        enableCache: false,
      });
    } else {
      throw new Error('Either oxyServices or baseURL must be provided to OxyProvider');
    }
  }
  const oxyServices = oxyServicesRef.current;
  useLayoutEffect(() => installNativeAssetFiles(oxyServices), [oxyServices]);

  const logger = useCallback((message: string, err?: unknown) => {
    if (__DEV__) {
      loggerUtil.warn(message, { component: 'OxyHostedContext' }, err);
    }
  }, []);

  const subjectChangeRef = useRef<(transition: SubjectTransition) => void>(() => undefined);
  const runtimeRef = useRef<OxyRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = createOxyRuntime({
      oxyServices,
      sessionClient: NO_DEVICE,
      sessionClientHost: NO_DEVICE_HOST,
      identity: null,
      onSubjectChange: (transition) => subjectChangeRef.current(transition),
      onDeviceEmpty: async () => undefined,
      logger,
    });
  }
  const runtime = runtimeRef.current;

  const host = 'host' in session ? session.host : null;

  // The user socket: the app token's `user:<id>` room, nothing of the device.
  const userSocketRef = useRef<UserEventSocket | null>(null);
  if (host && !userSocketRef.current) {
    userSocketRef.current = createUserEventSocket({
      baseURL: oxyServices.baseURL,
      getAccessToken: () => oxyServices.session.accessToken,
    });
  }
  const userSocket = userSocketRef.current;

  const hostSessionRef = useRef<HostSession | null>(null);
  if (host && !hostSessionRef.current) {
    hostSessionRef.current = createHostSession({
      host,
      oxyServices,
      runtime,
      logger,
      onTokenChange: (kind) => {
        if (kind === 'account') userSocketRef.current?.restart();
        else userSocketRef.current?.sync();
      },
    });
  }
  const hostSession = hostSessionRef.current;

  const snapshot = useRuntimeSnapshot(runtime);
  const {
    account: user,
    sessions,
    activeSessionId,
    isLoading,
    tokenReady,
    hasAccessToken,
  } = snapshot;
  const authResolved = snapshot.authResolved;
  const isAuthenticated = user !== null;
  const bearerSubject = useKnownBearerSubject(oxyServices);
  const subjectMismatch = hasKnownSubjectMismatch(user?.id, bearerSubject);
  const error = snapshot.error?.message ?? null;

  useEffect(() => bindAuthStoreToRuntime(runtime), [runtime]);

  const storageKeys = useMemo(() => getStorageKeys(storageKeyPrefix), [storageKeyPrefix]);
  const clientId = useMemo(() => {
    const trimmed = clientIdProp?.trim();
    return trimmed ? trimmed : null;
  }, [clientIdProp]);

  const queryClient = useQueryClient();
  const accountQueryPersistenceRef = useRef<AccountQueryPersistence | null>(null);
  if (accountQueryPersistenceRef.current === null) {
    accountQueryPersistenceRef.current = createAccountQueryPersistence(queryClient, accountQueries);
  }
  const accountQueryPersistence = accountQueryPersistenceRef.current;
  useEffect(() => {
    accountQueryPersistence.attach();
    return () => accountQueryPersistence.detach();
  }, [accountQueryPersistence]);
  const isAccountCacheReady = useSyncExternalStore(
    accountQueryPersistence.subscribe,
    accountQueryPersistence.isReady,
    accountQueryPersistence.isReady,
  );

  // Display and cache storage (the query cache, the language, the campaign).
  // Never a credential: a hosted provider persists no auth state at all.
  const [storage, setStorage] = useState<StorageInterface | null>(null);
  useEffect(() => {
    if (platformStorage === null) return;
    let mounted = true;
    const storagePromise = platformStorage
      ? Promise.resolve(platformStorage)
      : createPlatformStorage();
    storagePromise
      .then((storageInstance) => {
        accountQueryPersistence.setStorage(storageInstance);
        if (mounted) {
          setStorage(storageInstance);
          runtime.setStorageReady(true);
        }
      })
      .catch((err) => {
        const memoryStorage = createMemoryStorage();
        accountQueryPersistence.setStorage(memoryStorage);
        if (mounted) {
          setStorage(memoryStorage);
          runtime.setStorageReady(true);
          logger('Failed to initialize storage', err);
          onError?.({
            message: 'Failed to initialize storage',
            code: 'STORAGE_INIT_ERROR',
            status: 500,
          });
        }
      });
    return () => {
      mounted = false;
    };
  }, [accountQueryPersistence, logger, onError, platformStorage, runtime]);

  // Follow the host once the account cache can be activated. With a host this
  // SDK cannot speak to, resolve signed out and stay there.
  const storageAvailable = storage !== null;
  useEffect(() => {
    if (!storageAvailable) return undefined;
    if (!hostSession) {
      runtime.markAuthResolved();
      return undefined;
    }
    return hostSession.start();
  }, [storageAvailable, hostSession, runtime]);

  useEffect(
    () => () => {
      userSocket?.stop();
    },
    [userSocket],
  );

  const onAuthStateChangeRef = useRef(onAuthStateChange);
  useEffect(() => {
    onAuthStateChangeRef.current = onAuthStateChange;
  }, [onAuthStateChange]);
  const userId = user?.id ?? null;
  const reportedUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!authResolved || reportedUserIdRef.current === userId) return;
    reportedUserIdRef.current = userId;
    onAuthStateChangeRef.current?.(runtime.getSnapshot().account);
  }, [authResolved, userId, runtime]);

  const entryLink = useEntryLink({
    storage,
    storageKey: `${storageKeyPrefix}_campaign_attribution`,
    captureCampaign: captureCampaignAttribution,
    onError: logger,
  });
  const {
    currentLanguage,
    isLanguageReady,
    languages: currentLanguages,
    metadata: currentLanguageMetadata,
    languageName: currentLanguageName,
    nativeLanguageName: currentNativeLanguageName,
    setLanguage,
    setLanguages,
  } = useLanguageManagement({
    storage,
    languageKey: storageKeys.language,
    entryUrl: entryLink.url,
    entryLinkReady: entryLink.ready,
    legacyLanguageKeys,
    user,
    onError,
    logger,
  });

  const canUsePrivateApi =
    authResolved && isAuthenticated && tokenReady && hasAccessToken && !subjectMismatch;
  const isPrivateApiPending =
    !authResolved || (isAuthenticated && (!tokenReady || !hasAccessToken || subjectMismatch));

  // ── The platform's requests ─────────────────────────────────────────────
  const request = useCallback(
    async (action: OxyHostRequest): Promise<void> => {
      if (!hostSession) return;
      await hostSession.request(action);
    },
    [hostSession],
  );

  const signIn = useCallback(async (): Promise<User> => {
    await request('sign_in');
    const account = runtime.getSnapshot().account;
    if (account) return account;
    throw new HostedSessionError('signIn');
  }, [request, runtime]);

  const openAccountDialog = useCallback(
    (_view?: AccountDialogView): void => {
      const signedIn = runtime.getSnapshot().account !== null;
      void request(requestForDialog(signedIn)).catch((requestError) => {
        logger('The platform could not show its account UI', requestError);
      });
    },
    [request, runtime, logger],
  );
  const closeAccountDialog = useCallback((): void => undefined, []);

  useEffect(
    () => registerAccountDialogControls({ open: openAccountDialog, close: closeAccountDialog }),
    [openAccountDialog, closeAccountDialog],
  );
  useEffect(() => {
    notifyAccountDialogVisibility(false);
  }, []);

  const logout = useCallback(async (): Promise<LogoutResult> => {
    try {
      await request('sign_out');
      return { status: 'requested' };
    } catch (logoutError) {
      return { status: 'failed', error: logoutError };
    }
  }, [request]);

  const manageAccount = useCallback(async (): Promise<void> => {
    await request('manage_account');
  }, [request]);

  const switchToAccount = useCallback(
    async (_accountId: string): Promise<void> => {
      await request('switch_account');
    },
    [request],
  );

  const switchSession = useCallback(
    async (_sessionId: string): Promise<User> => {
      await request('switch_account');
      throw new HostedSessionError('switchSession');
    },
    [request],
  );

  const refreshSessions = useCallback(async (): Promise<void> => {
    await hostSession?.refresh();
  }, [hostSession]);

  const platformOwns = useCallback(
    (operation: string) => (): Promise<never> => Promise.reject(new HostedSessionError(operation)),
    [],
  );
  const handleWebSession = useMemo(() => platformOwns('handleWebSession'), [platformOwns]);
  const getDeviceSessions = useMemo(() => platformOwns('getDeviceSessions'), [platformOwns]);
  const updateDeviceName = useMemo(() => platformOwns('updateDeviceName'), [platformOwns]);

  const startWebOAuthSignIn = useCallback(
    async () => ({ status: 'unsupported' as const, reason: 'no-browser' as const }),
    [],
  );
  const startNativeOAuthSignIn = useCallback(
    async () => ({ status: 'unsupported' as const, reason: 'unsupported-platform' as const }),
    [],
  );
  const requestOAuthConsent = useCallback(
    async () => ({ status: 'unsupported' as const, reason: 'unsupported-platform' as const }),
    [],
  );

  // A hosted app holds no identity key and never signs in with one.
  const hasIdentity = useCallback(async (): Promise<boolean> => false, []);
  const getPublicKey = useCallback(async (): Promise<string | null> => null, []);

  // Nothing of the session is local, so there is nothing local to clear.
  const clearSessionState = useCallback(async (): Promise<void> => undefined, []);
  const clearAllAccountData = useCallback(async (): Promise<void> => {
    queryClient.clear();
    if (storage) {
      try {
        await clearQueryCache(storage);
      } catch (clearError) {
        logger('Failed to clear persisted query cache', clearError);
      }
    }
    oxyServices.cache.clear();
  }, [queryClient, storage, logger, oxyServices]);

  // ── The account graph: read through the API, switched by the platform ────
  const [accounts, setAccounts] = useState<AccountNode[]>([]);
  const refreshAccounts = useCallback(async (): Promise<void> => {
    if (!runtime.getSnapshot().account || !oxyServices.session.accessToken) {
      setAccounts([]);
      return;
    }
    try {
      setAccounts(await oxyServices.accounts.list());
    } catch (listError) {
      logger('Failed to load accounts', listError);
    }
  }, [runtime, oxyServices, logger]);
  useEffect(() => {
    if (canUsePrivateApi) void refreshAccounts();
    else if (userId === null) setAccounts([]);
  }, [canUsePrivateApi, userId, refreshAccounts]);
  const createAccount = useCallback(
    async (data: CreateAccountInput): Promise<AccountNode> => {
      const account = await oxyServices.accounts.create(data);
      await refreshAccounts();
      return account;
    },
    [oxyServices, refreshAccounts],
  );

  const handleSubjectChange = useCallback(
    ({ previous, next }: SubjectTransition): void => {
      accountQueryPersistence.activate(next);
      if (previous === null) return;
      resetSessionScopedStores();
      if (next === null) return;
      queryClient.removeQueries({ queryKey: [ASSET_DOWNLOAD_URLS_QUERY_KEY] });
      queryClient.invalidateQueries();
    },
    [accountQueryPersistence, queryClient],
  );
  useEffect(() => {
    subjectChangeRef.current = handleSubjectChange;
  }, [handleSubjectChange]);

  const showBottomSheet = useCallback(
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

  const onServerEvent = useCallback(
    (event: string, listener: (payload: unknown) => void): (() => void) =>
      userSocket ? userSocket.onServerEvent(event, listener) : () => undefined,
    [userSocket],
  );

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
      isAccountCacheReady,
      sessionMode: 'account',
      webAuthMode,
      error,
      currentLanguage,
      isLanguageReady: isLanguageReady && entryLink.campaignReady,
      campaignAttribution: entryLink.campaignAttribution,
      currentLanguages,
      currentLanguageMetadata,
      currentLanguageName,
      currentNativeLanguageName,
      hasIdentity,
      getPublicKey,
      signIn,
      revokeSuspiciousSignIn: manageAccount,
      handleWebSession,
      startWebOAuthSignIn,
      startNativeOAuthSignIn,
      requestOAuthConsent,
      logout,
      logoutAll: manageAccount,
      switchSession,
      removeSession: logout,
      refreshSessions,
      setLanguage,
      setLanguages,
      getDeviceSessions,
      logoutAllDeviceSessions: manageAccount,
      updateDeviceName,
      clearSessionState,
      clearAllAccountData,
      storageKeyPrefix,
      clientId,
      oxyServices,
      sessionClient: null,
      onServerEvent,
      useFollow,
      showBottomSheet,
      openAvatarPicker,
      accountDialogController: null,
      isAccountDialogOpen: false,
      openAccountDialog,
      closeAccountDialog,
      accounts,
      switchToAccount,
      refreshAccounts,
      createAccount,
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
      isAccountCacheReady,
      webAuthMode,
      error,
      currentLanguage,
      isLanguageReady,
      entryLink.campaignReady,
      entryLink.campaignAttribution,
      currentLanguages,
      currentLanguageMetadata,
      currentLanguageName,
      currentNativeLanguageName,
      hasIdentity,
      getPublicKey,
      signIn,
      manageAccount,
      handleWebSession,
      startWebOAuthSignIn,
      startNativeOAuthSignIn,
      requestOAuthConsent,
      logout,
      switchSession,
      refreshSessions,
      setLanguage,
      setLanguages,
      getDeviceSessions,
      updateDeviceName,
      clearSessionState,
      clearAllAccountData,
      storageKeyPrefix,
      clientId,
      oxyServices,
      onServerEvent,
      showBottomSheet,
      openAvatarPicker,
      openAccountDialog,
      closeAccountDialog,
      accounts,
      switchToAccount,
      refreshAccounts,
      createAccount,
    ],
  );

  const authActionsValue = useMemo<OxyAuthActionsContextState>(
    () => ({
      ensureDeviceSessionLane: () => undefined,
      hostRequest: request,
      signIn,
      logout,
      logoutAll: manageAccount,
      refreshSessions,
      oxyServices,
      switchToAccount,
      hasIdentity,
      getPublicKey,
      showBottomSheet,
      openAvatarPicker,
      openAccountDialog,
    }),
    [
      request,
      signIn,
      logout,
      manageAccount,
      refreshSessions,
      oxyServices,
      switchToAccount,
      hasIdentity,
      getPublicKey,
      showBottomSheet,
      openAvatarPicker,
      openAccountDialog,
    ],
  );

  // App assertions (ADR 0045) prove the app by its platform's integrity check;
  // a hosted app's proof is its host token (ADR 0058 2.7), a lane the assertion
  // manager does not speak yet. Until it does, no assertion is attempted here
  // rather than one through the wrong platform's lane.
  return (
    <OxyRuntimeHandleProvider value={runtime}>
      <OxyAuthActionsContext.Provider value={authActionsValue}>
        <OxyRuntimeContext.Provider value={contextValue}>
          <AppAssertionProvider
            oxyServices={oxyServices}
            clientId={clientId}
            userId={null}
            sessionId={null}
            storage={storage}
            storageKeyPrefix={storageKeyPrefix}
          >
            {children}
          </AppAssertionProvider>
        </OxyRuntimeContext.Provider>
      </OxyAuthActionsContext.Provider>
    </OxyRuntimeHandleProvider>
  );
};
