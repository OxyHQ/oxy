import type { ReactNode } from 'react';
import type { OxyServices, User, SessionLoginResponse, AccountNode, CreateAccountInput, ClientSession, AccountDialogController, AccountDialogView, ApiError, SessionClient, SessionMode } from '@oxyhq/core';
import type { UseFollowHook } from '../hooks/useFollow.types';
import type { useLanguageManagement } from '../hooks/useLanguageManagement';
import type { RouteName } from '../navigation/routes';
import type { StartWebOAuthSignInOptions } from '../oauth/browserAuthTransport';
import type { WebAuthMode, WebOAuthSignInResult } from '../oauth/types';

export interface OxyContextState {
  user: User | null;
  sessions: ClientSession[];
  activeSessionId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isTokenReady: boolean;
  hasAccessToken: boolean;
  canUsePrivateApi: boolean;
  isPrivateApiPending: boolean;
  /**
   * Whether the initial auth determination has concluded.
   *
   * `false` from mount until the FIRST device-first cold boot resolves —
   * during that window `isAuthenticated: false` is UNDETERMINED, not a
   * definitive "logged out". Flips to `true` exactly once the boot concludes
   * (a session was committed OR none exists) and never reverts. Consumers should
   * defer their first auth-dependent fetch until this is `true` so a cold-boot
   * web reload with an existing session does not fetch anonymous data.
   */
  isAuthResolved: boolean;
  isStorageReady: boolean;
  /**
   * Who owns this provider's session (see `OxyProviderProps.sessionMode`).
   *
   * `'account'` — the device's active account; any app on the device can switch
   * it and this client follows. `'identity'` — the owner of the local primary
   * identity key, permanently: a sibling app's account switch never changes this
   * client's user or bearer, and every account-graph mutation
   * (`switchToAccount` / `switchSession`) rejects with `IdentityBoundSessionError`
   * while `accounts` stays empty and the account dialog never opens.
   */
  sessionMode: SessionMode;
  /** How web third-party sign-in reaches the IdP (see `OxyProviderProps.webAuthMode`). */
  webAuthMode: WebAuthMode;
  error: string | null;
  /** Active UI locale (`language-REGION`): the account's primary locale when signed in, else the guest/device locale. */
  currentLanguage: string;
  /** Ordered account locales (primary first) when signed in, or the single guest override when signed out. */
  currentLanguages: string[];
  currentLanguageMetadata: ReturnType<typeof useLanguageManagement>['metadata'];
  currentLanguageName: string;
  currentNativeLanguageName: string;

  hasIdentity: () => Promise<boolean>;
  getPublicKey: () => Promise<string | null>;

  signIn: (publicKey: string, deviceName?: string) => Promise<User>;

  /**
   * Sign in with a passkey (WebAuthn). With no `username` this is the
   * usernameless / discoverable-credential flow: the browser prompts for any
   * resident Oxy passkey. Pass `username` for the username-first flow — the
   * server scopes `allowCredentials` to that user's passkeys so a
   * NON-discoverable hardware key (e.g. a U2F/security key) can be used.
   * WEB-ONLY — throws on native or an unsupported browser (native passkeys are
   * Commons' job). On `useOxy()`, NOT re-exposed on `useAuth()`.
   */
  signInWithPasskey: (opts?: {
    username?: string;
    deviceName?: string;
    deviceFingerprint?: string;
  }) => Promise<void>;

  /**
   * Create a brand-new account whose first authentication method is a passkey.
   * WEB-ONLY — throws on native or an unsupported browser.
   */
  registerWithPasskey: (params: { username: string; deviceName?: string }) => Promise<void>;

  /**
   * Add a passkey to the already-signed-in account (bearer present). Does NOT
   * commit a new session; refreshes the linked auth-methods list on success.
   * WEB-ONLY — throws on native or an unsupported browser.
   */
  addPasskey: (params?: { deviceName?: string }) => Promise<void>;

  /**
   * Remove a passkey from the current account by its credential id
   * (`AuthMethodEntry.credentialId`). Refreshes the linked auth-methods list on
   * success. Works on any platform (it is a plain unlink, not a WebAuthn
   * ceremony) but is only reachable from surfaces that list passkeys.
   */
  removePasskey: (credentialId: string) => Promise<void>;

  revokeSuspiciousSignIn: () => Promise<void>;
  handleWebSession: (session: SessionLoginResponse) => Promise<void>;

  /**
   * Run a WEB third-party OAuth sign-in (authorization code + PKCE) end to end
   * using this provider's `webAuthMode`, and commit the resulting session.
   *
   * This is the shared operation `OxySignInButton` delegates to; RPs that ship
   * their own button call it directly and never implement popup listeners, a
   * token exchange, or `state` validation themselves. Returns a typed result —
   * closing the popup and running out of time are values, not exceptions.
   *
   * In popup mode the window MUST be opened during the user's click: either
   * call this synchronously from the press handler (it opens one itself), or
   * call `openOAuthPopup()` there and pass the handle as `popup`.
   *
   * No-op outside a browser and in `sessionMode: 'identity'`, both of which
   * resolve to `{ status: 'unsupported' }`.
   */
  startWebOAuthSignIn: (options: StartWebOAuthSignInOptions) => Promise<WebOAuthSignInResult>;

  logout: (targetSessionId?: string) => Promise<void>;
  logoutAll: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<User>;
  removeSession: (sessionId: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  setLanguage: (languageId: string) => Promise<void>;
  getDeviceSessions: () => Promise<
    Array<{
      sessionId: string;
      deviceId: string;
      deviceName?: string;
      lastActive?: string;
      expiresAt?: string;
    }>
  >;
  logoutAllDeviceSessions: () => Promise<void>;
  updateDeviceName: (deviceName: string) => Promise<void>;
  clearSessionState: () => Promise<void>;
  clearAllAccountData: () => Promise<void>;
  storageKeyPrefix: string;
  clientId: string | null;
  oxyServices: OxyServices;
  /** Server-authoritative device session client. `null` before an `OxyProvider` is mounted. */
  sessionClient: SessionClient | null;
  useFollow?: UseFollowHook;
  showBottomSheet?: (screenOrConfig: RouteName | { screen: RouteName; props?: Record<string, unknown> }) => void;
  openAvatarPicker: () => void;

  accountDialogController: AccountDialogController | null;
  isAccountDialogOpen: boolean;
  openAccountDialog: (view?: AccountDialogView) => void;
  closeAccountDialog: () => void;

  accounts: AccountNode[];
  switchToAccount: (accountId: string) => Promise<void>;
  refreshAccounts: () => Promise<void>;
  createAccount: (data: CreateAccountInput) => Promise<AccountNode>;
}

export interface OxyRuntimeProviderProps {
  children: ReactNode;
  oxyServices?: OxyServices;
  baseURL?: string;
  authWebUrl?: string;
  authRedirectUri?: string;
  /**
   * Authorize endpoint override for web "Sign in with Oxy". Defaults to the
   * production Oxy IdP when unset; a local/staging deployment points it at its
   * own IdP so sign-in never reaches production `auth.oxy.so`.
   */
  authorizeBaseUrl?: string;
  storageKeyPrefix?: string;
  clientId?: string;
  /**
   * Who owns this provider's session. See `OxyProviderProps.sessionMode` for the
   * full contract.
   * @default 'account'
   */
  sessionMode?: SessionMode;
  /**
   * Transport for WEB third-party sign-in. See `OxyProviderProps.webAuthMode`.
   * @default 'popup'
   */
  webAuthMode?: WebAuthMode;
  /**
   * Let NATIVE background code (a home-screen widget's WorkManager worker, a sync
   * job) authenticate while the app process is dead and there is no JS runtime.
   *
   * With this on, the SDK provisions a purpose-built background credential
   * whenever the app runs and stores it where `so.oxy.session.OxyBackgroundSession`
   * can read it; Kotlin then exchanges it for a short access token on demand. The
   * app writes no session code — this prop is the whole integration.
   *
   * OFF by default, because a credential that nobody needs is exposure that
   * nobody needs. Turn it on only in an app that actually has background code to
   * authenticate. Android-only today; inert on web and iOS.
   *
   * The credential cannot create a session (only the running app can provision
   * one), cannot rotate or otherwise disturb the app's own device credential, and
   * is re-authorized server-side on every use so it can never outlive a sign-out.
   * It does NOT reduce authority: the token it mints is a full user access token,
   * exactly like the device credential's.
   *
   * @default false
   */
  backgroundSession?: boolean;
  /**
   * Whether this origin/app persists the durable device credential at all. See
   * `OxyProviderProps.deviceCredentialStorage` for the full rule and the one
   * caller of `'ephemeral'`.
   *
   * @default 'persistent'
   */
  deviceCredentialStorage?: 'persistent' | 'ephemeral';
  onAuthStateChange?: (user: User | null) => void;
  onError?: (error: ApiError) => void;
}

/** Internal commit input — session plus zero-cookie device credential. */
export interface CommitInput {
  sessionId: string;
  accessToken?: string;
  deviceId?: string;
  deviceSecret?: string;
  expiresAt?: string;
  userId?: string;
  user?: { id: string; username?: string; avatar?: string };
}
