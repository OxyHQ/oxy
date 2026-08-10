/**
 * Headless controller for the unified Oxy account dialog.
 *
 * A framework-agnostic state machine + subscribe/getSnapshot store (the same
 * pattern {@link SessionClient} uses — no React, no RN) that both
 * every `OxyProvider` platform variant (Expo/RN and RN-Web)
 * bind to via `useSyncExternalStore`, so the account chooser is ONE
 * implementation across the ecosystem instead of the five drifting copies it
 * replaces.
 *
 * The controller owns:
 *   - the unified account list (via {@link projectSwitchableAccounts}), fetched
 *     from `SessionClient` state ∪ `oxyServices.listAccounts()` and hydrated
 *     with `oxyServices.getUsersByIds()`;
 *   - the dialog `view` state machine (`accounts` | `signin` | `qr` | `add` |
 *     `signup`);
 *   - `switchTo` (the uniform switch: `SessionClient.switchAccount` for an
 *     account already on the device, `oxyServices.switchToAccount` to mint on
 *     first entry into a graph account — reusing the existing SDK primitives, no
 *     new switch path);
 *   - the "Sign in with Oxy" device flow (same-device shared-keychain via
 *     `oxyServices.signInWithSharedIdentity`, else the cross-device QR handoff
 *     via `startCommonsSignIn` → poll → `claimSessionByToken`);
 *   - AUTOMATIC delivery selection for that flow (issue #691): the user presses
 *     ONE primary action and the controller — not the user — picks how the
 *     request reaches their Commons identity, by gathering the facts
 *     (`platform`, `commonsAvailability`, and the `targets` a bearer-authorized
 *     `deliverCommonsSignIn` reached) and handing them to the pure
 *     `selectCommonsDelivery`. Exactly one route is primary; alternatives are
 *     never chained behind it, they are state (`signIn.route`,
 *     `signIn.routeFailed`) the UI reveals on its own terms;
 *   - honest, non-sensitive PROGRESS for that flow (`signIn.progress`), derived
 *     only from real signals — the chosen route, `pushSentAt`, `openedAt`,
 *     `authorized`, and the commit — never from an optimistic timeline;
 *   - `commonsAvailability` — whether Commons is installed on this device
 *     (native only, via the injected `canOpenApp` probe), so the QR view can
 *     offer a "Get Commons" fallback instead of a same-device dead end.
 *   - `startPasskeyHubSignIn` — on a non-Oxy web origin (where a WebAuthn
 *     ceremony can't run locally, the RP-ID is bound to oxy.so), open a popup
 *     at the auth.oxy.so passkey hub instead, scoped to the SAME device-flow
 *     session `showQr` creates, and complete it via the SAME poll/socket/claim
 *     engine. Falls back to `showQr`'s plain QR rendering if the popup is
 *     blocked.
 *
 * Sign-in is passkey (WebAuthn) or the Commons QR / shared-keychain handoff —
 * password, social login, and 2FA were removed ecosystem-wide. Account
 * creation (`signup` view) is the same two identity backends: a passkey
 * ceremony on web, or a Commons-created identity.
 *
 * The controller owns NO surface PRESENTATION: whether the account dialog is
 * mounted, visible, or dismissed is the job of the shared surface stack
 * (`@oxyhq/services` presents the `AccountDialog` surface into `@oxyhq/bloom`'s
 * stack). This is a headless state machine only — it exposes `setView` /
 * `add` / `startSignup` (the view axis) and `cancelSignIn` (device-flow
 * teardown), never an `open` / `close` / `visible`.
 */

import type { DeviceDirectory } from '@oxyhq/contracts';
import type { OxyServices } from '../OxyServices';
import type { SessionLoginResponse, MinimalUserData } from '../models/session';
import type { User } from '../models/interfaces';
import { logger } from '../logger';
import { extractErrorStatus } from '../utils/errorUtils';
import { CENTRAL_IDP_APEX } from '../utils/authWebUrl';
import type { SessionClient } from './SessionClient';
import type { MinimalSocket, SocketIOFactory } from './socketLoader';
import {
  projectSwitchableAccounts,
  switchableAccountIds,
  type SwitchableAccount,
} from './accountProjection';
import { resolveActiveContext, type DeviceContext } from './deviceDirectory';
import type { AccountNode } from '../mixins/OxyServices.accounts';
import type { CommonsSignInHandle } from '../mixins/OxyServices.auth';
import {
  pushTargetsFromDelivery,
  selectCommonsDelivery,
  type CommonsDeliveryPlatform,
  type CommonsDeliveryRoute,
} from '../utils/commonsDelivery';

/** The dialog's top-level view. */
export type AccountDialogView = 'accounts' | 'signin' | 'qr' | 'add' | 'signup';

/**
 * Whether Commons is installed on this device, as resolved by the injected
 * `canOpenApp` probe:
 *   - `'unknown'` — not yet probed, OR no probe was injected (web — there is
 *     no API to ask a browser whether a custom URL scheme is registered, so
 *     this stays `'unknown'` forever there and the QR view renders
 *     unconditionally, no gating).
 *   - `'checking'` — the probe is in flight.
 *   - `'available'` / `'unavailable'` — the probe's resolved terminal answer
 *     (native only). A probe error is treated as `'unavailable'` (fail-closed).
 */
export type CommonsAvailability = 'unknown' | 'checking' | 'available' | 'unavailable';

/**
 * Lifecycle phase of the "Sign in with Oxy" device flow — the RESOURCE state
 * (is there a live request, a claim in flight, a terminal outcome), as opposed
 * to {@link SignInProgress}, which is what the user is told.
 *
 * `'completed'` is terminal-but-successful: the session was claimed and
 * committed, nothing is in flight, and the surface may show "Identity
 * confirmed" before it goes away. It is cleared back to `'idle'` the moment the
 * dialog moves to another view (a new intention), so a later sign-in entry can
 * never inherit the previous flow's terminal state.
 */
export type SignInFlowPhase =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'authorized'
  | 'completed'
  | 'error';

/**
 * Ordered, non-sensitive progress of the active request — the ONE thing the
 * sign-in surface renders its status line from (issue #691, Phase 5).
 *
 * Every step is DERIVED from a real fact the controller observed; there is no
 * optimistic sequence and no timer that advances it. The mapping the UI is
 * expected to render (copy lives in the UI layer, never here):
 *
 * | value                  | shown as                       | advanced by |
 * |------------------------|--------------------------------|-------------|
 * | `idle`                 | (nothing)                      | no live request, or a terminal error |
 * | `preparing`            | "Preparing request"            | the request is being created / its route is still being resolved |
 * | `awaiting-approval`    | route-specific waiting copy    | the primary route is known (`qr` → the QR itself, `open-commons` → "Continue in Commons") |
 * | `delivered-to-commons` | "Check Commons on your phone"  | the server confirmed a push to ≥1 known Commons install (`await-push`, or `pushSentAt`) |
 * | `opened-in-commons`    | "Opened in Commons"            | the approver reported `openedAt` |
 * | `confirming-identity`  | "Confirming identity"          | the request reported `authorized`; the claim/commit is running |
 * | `identity-confirmed`   | "Identity confirmed"           | the session was claimed and committed |
 *
 * `opened-in-commons` and `delivered-to-commons` are PROGRESS only — neither is
 * evidence of an approval. Only `authorized` moves the flow forward.
 */
export type SignInProgress =
  | 'idle'
  | 'preparing'
  | 'awaiting-approval'
  | 'delivered-to-commons'
  | 'opened-in-commons'
  | 'confirming-identity'
  | 'identity-confirmed';

/**
 * Minimal structural handle over a popup `Window` — just enough for the
 * cross-origin passkey hub flow ({@link AccountDialogController.startPasskeyHubSignIn}):
 * navigate it once the device-flow session's `authorizeCode` is known, detect
 * the user closing it early (`closed`), and close it programmatically on
 * completion/failure. Satisfied directly by `window.open()`'s return value on
 * web; native has no popup concept and never injects an opener.
 */
export interface PopupWindowHandle {
  readonly closed: boolean;
  close(): void;
  location: { href: string };
}

/**
 * State of the "Sign in with Oxy" (shared-key / QR) device flow.
 *
 * Everything here is safe to render. The flow's SECRET credential (the
 * device-flow `sessionToken`) is deliberately absent — it never leaves the
 * controller's private field, so no surface, log, or serialized snapshot can
 * leak it.
 */
export interface SignInFlowState {
  phase: SignInFlowPhase;
  /**
   * The PUBLIC, single-use authorize code (safe to display), or `null`. NOT the
   * secret `sessionToken` — the approver resolves the app identity from this.
   */
  authorizeCode: string | null;
  /**
   * The structured deep-link / QR payload (`oxycommons://approve?...`) to render
   * as a QR (cross-device) and open as a deep link (same-device), or `null`.
   */
  qrPayload: string | null;
  /** Server-authoritative expiry (epoch ms), or `null`. */
  expiresAt: number | null;
  /** Human-readable error for the retry UI, or `null`. */
  error: string | null;
  /**
   * The ONE primary delivery route the controller chose for this request
   * ({@link selectCommonsDelivery}), or `null` while it is still being resolved.
   *
   * There is no chain: exactly one route is primary, and the UI renders exactly
   * one action for it. Alternatives stay behind a "Having trouble?" affordance
   * that the UI reveals on its own terms — see {@link routeFailed}.
   */
  route: CommonsDeliveryRoute | null;
  /**
   * `true` when the chosen primary route could NOT be carried out on this
   * device — today only `'open-commons'` can fail this way (no URL opener was
   * injected, or opening the verified Commons link threw). It is the signal the
   * UI needs to reveal its alternatives; the controller never cascades to
   * another route by itself.
   *
   * A push that reached zero installations is NOT a failure: no capable Commons
   * install is a normal outcome that simply resolves the primary route to
   * `'qr'`.
   */
  routeFailed: boolean;
  /**
   * Server-reported ISO-8601 timestamp of when the request was pushed to a
   * known Commons installation, or `null`. Progress only — never evidence of an
   * approval. Monotone: once observed it is never cleared by a later, emptier
   * poll response.
   */
  pushSentAt: string | null;
  /**
   * Server-reported ISO-8601 timestamp of when the approval route was OPENED in
   * Commons, or `null`. Progress only — never evidence of an approval. Monotone,
   * like {@link pushSentAt}.
   */
  openedAt: string | null;
  /**
   * The derived, ordered progress the surface renders. Always computed from the
   * facts above by {@link deriveSignInProgress} — never assigned directly, so it
   * cannot drift from them or run ahead of a real signal.
   */
  progress: SignInProgress;
}

/**
 * The observable FACTS of a device flow — {@link SignInFlowState} minus the
 * value derived from them. Every mutation of the flow goes through this shape,
 * which is what makes `progress` structurally impossible to set by hand.
 */
type SignInFlowFacts = Omit<SignInFlowState, 'progress'>;

/**
 * Derive the surface-facing progress from the flow's real facts. Pure, total,
 * and the single place the ladder is defined.
 *
 * Ordering within `'waiting'` is most-specific-first, so a late-arriving weaker
 * signal can never pull the display backwards.
 */
function deriveSignInProgress(facts: SignInFlowFacts): SignInProgress {
  switch (facts.phase) {
    case 'idle':
    case 'error':
      return 'idle';
    case 'starting':
      return 'preparing';
    case 'authorized':
      return 'confirming-identity';
    case 'completed':
      return 'identity-confirmed';
    case 'waiting':
      if (facts.openedAt !== null) return 'opened-in-commons';
      // `route === 'await-push'` is itself a server-confirmed dispatch (the
      // route is only chosen when `deliverCommonsSignIn` reported ≥1 target),
      // so it is a real signal — not an optimistic assumption that a push will
      // arrive. `pushSentAt` is the same fact re-confirmed by the status poll.
      if (facts.pushSentAt !== null || facts.route === 'await-push') return 'delivered-to-commons';
      return facts.route === null ? 'preparing' : 'awaiting-approval';
  }
}

/** Immutable snapshot consumed by `useSyncExternalStore`. */
export interface AccountDialogSnapshot {
  /** The current view. */
  view: AccountDialogView;
  /**
   * The server-authoritative device directory — principals and the contexts
   * each may act as (ADR 0002) — or `null` before the first read.
   *
   * This is the read model a switcher should render. {@link accounts} below is
   * the compatibility adapter it replaces, and the two are NOT redundant: the
   * flat list is keyed by account id, so on a device holding two people it can
   * show one route to a shared organization and never both.
   */
  directory: DeviceDirectory | null;
  /** The active `principal acting as account` pair, actor and subject apart. */
  activeContext: DeviceContext | null;
  /**
   * The unified, deduped account list (device sign-ins ∪ graph accounts).
   *
   * The COMPATIBILITY projection, kept while consumers move to
   * {@link directory}. It is the one place this controller still reconstructs a
   * caller's account graph — which ADR 0002 removes precisely because a client
   * holds one caller's graph and cannot enumerate the other principals'.
   */
  accounts: SwitchableAccount[];
  /** The currently-active account id, or `null` when signed out. */
  activeAccountId: string | null;
  /** `true` while the initial account-list fetch is in flight with no data yet. */
  loading: boolean;
  /** A human-readable account-list error, or `null`. */
  error: string | null;
  /** The `accountId` of an in-flight switch, or `null`. */
  switchingAccountId: string | null;
  /** The `contextId` of an in-flight activation, or `null`. */
  activatingContextId: string | null;
  /** The "Sign in with Oxy" device-flow state. */
  signIn: SignInFlowState;
  /** Whether Commons is installed on this device. See {@link CommonsAvailability}. */
  commonsAvailability: CommonsAvailability;
}

/** Construction options for {@link AccountDialogController}. */
export interface AccountDialogControllerOptions {
  /** The API client. Source of graph accounts, profiles, and the sign-in methods. */
  oxyServices: OxyServices;
  /** The device-first session authority. Source of device rows + the switch path. */
  sessionClient: SessionClient;
  /**
   * The RP's registered OAuth client id (ApplicationCredential publicKey).
   * Required for the QR handoff (`startCommonsSignIn`); when absent, `showQr`
   * fails with a clear configuration error instead of creating a session the
   * server would reject.
   */
  clientId?: string | null;
  /** Locale for display-name resolution. */
  locale?: string;
  /**
   * Commit a freshly-authorized SIGN-IN session (device flow / shared identity)
   * into the host's session set — device-first registration + durable persist +
   * profile hydration. The consumer supplies its provider's commit path
   * (`useOxy().handleWebSession` / the auth-sdk equivalent). Called AFTER the SDK
   * has planted the access token. When omitted the controller falls back to
   * `SessionClient.registerAndActivate` (registration + activation only — no
   * provider-side durable persist/hydration).
   *
   * This is the SIGN-IN commit: registers the session into the host's device
   * set with durable persist + profile hydration. An account SWITCH uses
   * {@link commitSwitchedSession} instead — see below.
   */
  commitSession?: (session: SessionLoginResponse) => Promise<void>;
  /**
   * Commit a minted graph SWITCH session into the host's session set — same
   * device-first registration + durable persist + profile hydration as
   * {@link commitSession}, but IN-PLACE: it must NOT re-run sign-in side effects
   * that belong only to a fresh authorization (for example, a redundant full
   * device-set reconcile on switch). Cross-tab/app propagation of the switch
   * still happens instantly via the server's device-scoped `session_state` /
   * `session_accounts_changed` socket broadcast — no navigation required.
   *
   * When omitted the controller falls back to {@link commitSession} (if wired)
   * and then to `SessionClient.registerAndActivate`.
   */
  commitSwitchedSession?: (session: SessionLoginResponse) => Promise<void>;
  /** Notified after a completed sign-in (bearer planted + session committed). */
  onSignedIn?: (user: MinimalUserData) => void;
  /**
   * QR device-flow FALLBACK poll interval in ms (default 12000). The primary
   * approval signal is the `/auth-session` socket's `auth_update` event (instant);
   * this slow poll is only the safety net for when the socket can't connect.
   */
  pollIntervalMs?: number;
  /**
   * Statically-injected `socket.io-client` factory (its `io` export), same as
   * {@link SessionClient}'s. When provided, the QR flow subscribes to the
   * `/auth-session` namespace for an INSTANT `auth_update` wake instead of relying
   * on the slow fallback poll. Absent on web builds without a bundled `io` and in
   * headless/core usage → the controller silently degrades to poll-only.
   */
  socketFactory?: SocketIOFactory;
  /**
   * Optional URL opener. When provided, the controller invokes it to deep-link
   * the Commons app for the QR handoff (web: `location.assign`; native:
   * `Linking.openURL`). Headless core never touches `window`/`Linking` itself.
   */
  openUrl?: (url: string) => void;
  /**
   * Optional "can this app open this URL scheme?" probe, symmetric to
   * {@link openUrl}. When provided, `showQr` uses it to detect an installed
   * Commons (`oxycommons://`) and, if present, deep-links straight into its
   * approve screen via {@link openUrl} — while KEEPING the QR/polling active as
   * the fallback. Injected by the provider (native: `Linking.canOpenURL`; web:
   * absent/false). Headless core never touches `Linking` itself; when absent
   * `showQr` behaves exactly as before (render QR only).
   */
  canOpenApp?: (url: string) => Promise<boolean>;
  /**
   * Open a new, empty popup window SYNCHRONOUSLY (before any `await`) so the
   * browser attributes it to the click gesture that triggered it, returning a
   * handle to navigate once the device-flow session is known — or `null` if
   * the popup was blocked. Injected by the provider (web only:
   * `window.open('', ...)`; absent on native, where the hub-popup flow does
   * not apply). Used by {@link AccountDialogController.startPasskeyHubSignIn}.
   */
  openPopup?: () => PopupWindowHandle | null;
  /**
   * Base origin of the auth.oxy.so passkey hub (defaults to
   * `https://auth.${CENTRAL_IDP_APEX}`). Overridable for local/staging testing.
   */
  hubBaseUrl?: string;
  /**
   * Which surface the sign-in is initiated from — a FACT supplied by the
   * consumer, because only the consumer can classify its own environment
   * (native → `'mobile'`; web → `'mobile'` for a mobile browser, `'desktop'`
   * otherwise). Headless core never sniffs a user agent or a platform global.
   *
   * Feeds {@link selectCommonsDelivery} verbatim. Defaults to `'unknown'`,
   * which is a first-class value there: an unclassified surface never opts into
   * the deep-link route, because a custom-scheme navigation that does not
   * resolve is a dead end with no automatic way back.
   */
  platform?: CommonsDeliveryPlatform;
}

/**
 * Slow FALLBACK poll cadence for the QR flow. The `/auth-session` socket delivers
 * the approval instantly via `auth_update`; this poll only covers the case where
 * the socket can't connect, so it is deliberately slow (was 3000 when polling was
 * the sole mechanism).
 */
const DEFAULT_POLL_INTERVAL_MS = 12000;

/** Socket.IO namespace the API emits QR-flow approval (`auth_update`) events on. */
const AUTH_SESSION_NAMESPACE = '/auth-session';

/**
 * Commons's custom URL scheme. Probed via the injected `canOpenApp` to detect an
 * installed Commons on the same device; the `oxycommons://approve?...` deep link
 * itself is the flow's `qrPayload`.
 */
const COMMONS_APP_SCHEME = 'oxycommons://';

const IDLE_SIGN_IN_FACTS: SignInFlowFacts = {
  phase: 'idle',
  authorizeCode: null,
  qrPayload: null,
  expiresAt: null,
  error: null,
  route: null,
  routeFailed: false,
  pushSentAt: null,
  openedAt: null,
};

const IDLE_SIGN_IN: SignInFlowState = {
  ...IDLE_SIGN_IN_FACTS,
  progress: deriveSignInProgress(IDLE_SIGN_IN_FACTS),
};

/**
 * Terminal SUCCESS state: the session was claimed and committed. Holds no live
 * resources and no request handles — only the terminal progress the surface
 * shows ("Identity confirmed") before it closes.
 */
const COMPLETED_SIGN_IN: SignInFlowState = {
  ...IDLE_SIGN_IN_FACTS,
  phase: 'completed',
  progress: deriveSignInProgress({ ...IDLE_SIGN_IN_FACTS, phase: 'completed' }),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SnapshotListener = (snapshot: AccountDialogSnapshot) => void;

export class AccountDialogController {
  private readonly oxyServices: OxyServices;
  private readonly sessionClient: SessionClient;
  private readonly clientId: string | null;
  private readonly locale?: string;
  private readonly commitSession?: (session: SessionLoginResponse) => Promise<void>;
  private readonly commitSwitchedSession?: (session: SessionLoginResponse) => Promise<void>;
  private readonly onSignedIn?: (user: MinimalUserData) => void;
  private readonly pollIntervalMs: number;
  private readonly openUrl?: (url: string) => void;
  private readonly canOpenApp?: (url: string) => Promise<boolean>;
  private readonly socketFactory?: SocketIOFactory;
  private readonly openPopup?: () => PopupWindowHandle | null;
  private readonly hubBaseUrl: string;
  private readonly platform: CommonsDeliveryPlatform;

  private readonly listeners = new Set<SnapshotListener>();

  // --- Internal (unprojected) state ---
  private view: AccountDialogView = 'accounts';
  private graph: AccountNode[] = [];
  private profilesById = new Map<string, User>();
  private loading = false;
  private error: string | null = null;
  private switchingAccountId: string | null = null;
  private activatingContextId: string | null = null;
  private signIn: SignInFlowState = IDLE_SIGN_IN;
  private commonsAvailability: CommonsAvailability = 'unknown';

  // --- Sign-in device-flow bookkeeping ---
  /** The secret device-flow token of the active QR flow (never surfaced). */
  private signInToken: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The `/auth-session` socket for the active QR flow, or null (poll-only). Its
   * `auth_update` event wakes {@link pollOnce} instantly instead of waiting for the
   * slow fallback timer.
   */
  private authSessionSocket: MinimalSocket | null = null;
  /**
   * Guards {@link pollOnce} against re-entrancy: the fallback timer and a socket
   * `auth_update` wake can fire together — without this both could claim the
   * single-use token concurrently.
   */
  private pollInFlight = false;
  /** The popup opened by {@link startPasskeyHubSignIn}, or `null`. */
  private activePopup: PopupWindowHandle | null = null;
  /** Watches {@link activePopup}'s `closed` state; see {@link watchPopup}. */
  private popupWatchTimer: ReturnType<typeof setInterval> | null = null;

  // --- Store plumbing ---
  private unsubscribeSession: (() => void) | null = null;
  private unsubscribeTokens: (() => void) | null = null;
  /** Last-observed SDK auth readiness (a planted bearer). Drives the fetch edge. */
  private authed = false;
  private started = false;
  private refreshSeq = 0;
  private snapshot: AccountDialogSnapshot;

  constructor(options: AccountDialogControllerOptions) {
    this.oxyServices = options.oxyServices;
    this.sessionClient = options.sessionClient;
    this.clientId = options.clientId ?? null;
    this.locale = options.locale;
    this.commitSession = options.commitSession;
    this.commitSwitchedSession = options.commitSwitchedSession;
    this.onSignedIn = options.onSignedIn;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.openUrl = options.openUrl;
    this.canOpenApp = options.canOpenApp;
    this.socketFactory = options.socketFactory;
    this.openPopup = options.openPopup;
    this.hubBaseUrl = options.hubBaseUrl ?? `https://auth.${CENTRAL_IDP_APEX}`;
    this.platform = options.platform ?? 'unknown';
    this.snapshot = this.computeSnapshot();
  }

  // =========================================================================
  // Store surface (useSyncExternalStore)
  // =========================================================================

  /** Returns the current immutable snapshot (stable reference between changes). */
  getSnapshot(): AccountDialogSnapshot {
    return this.snapshot;
  }

  /** Subscribe to snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Begin driving the dialog: subscribe to `SessionClient` state and load the
   * account list. Idempotent — a second `start()` is a no-op. Pair with
   * {@link destroy}.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.authed = this.isAuthenticated();
    this.unsubscribeSession = this.sessionClient.subscribe(() => {
      // A device-state change (switch / sign-out / sibling sign-in) can add or
      // remove accounts — re-project immediately, refetch profiles when new
      // account ids appeared, and reconcile the auth-readiness edge.
      this.emit();
      void this.ensureProfiles();
      this.reconcileAuth();
    });
    // The access token is planted AFTER `SessionClient.applyState` fires its
    // subscription (`applySync` calls `setTokens` only once `applyState`/notify
    // has returned; `ensureActiveToken` plants it async later), so the
    // device-state subscription alone cannot observe the signed-out → signed-in
    // edge. Observe the SDK-canonical readiness signal directly — a change to
    // `oxyServices.getAccessToken()`, the `hasAccessToken` term of
    // `OxyContext.canUsePrivateApi`.
    this.unsubscribeTokens = this.oxyServices.onTokensChanged(() => {
      this.reconcileAuth();
    });
    // Initial projection is device-only. `refresh()` fetches the graph IFF a
    // bearer is already planted (warm start); when signed out (cold boot before
    // restore) it re-projects from device state and makes NO private call.
    void this.refresh();
    // Eager, cached Commons-availability probe (native only — a no-op when no
    // `canOpenApp` was injected). It's a cheap local OS check, so by the time a
    // user actually opens the sign-in entry it has almost always resolved —
    // `showQr`'s own lazy probe below is only the safety net for the rare race.
    void this.resolveCommonsAvailability();
  }

  /**
   * Stop driving the dialog: unsubscribe from `SessionClient` and tear down the
   * active sign-in flow (timers). Idempotent.
   */
  destroy(): void {
    this.started = false;
    if (this.unsubscribeSession) {
      this.unsubscribeSession();
      this.unsubscribeSession = null;
    }
    if (this.unsubscribeTokens) {
      this.unsubscribeTokens();
      this.unsubscribeTokens = null;
    }
    this.clearPollTimer();
    this.closeAuthSessionSocket();
    this.closeActivePopup();
    this.signInToken = null;
    this.listeners.clear();
  }

  // =========================================================================
  // Auth readiness (SDK-canonical — mirrors OxyContext.canUsePrivateApi)
  // =========================================================================

  /**
   * Whether a PRIVATE endpoint may be called right now. Mirrors the
   * `hasAccessToken` term of `OxyContext.canUsePrivateApi`
   * (`authResolved && isAuthenticated && tokenReady && hasAccessToken`, where
   * `hasAccessToken = Boolean(oxyServices.getAccessToken())`): a planted bearer
   * is the only term that decides whether a request carries auth — the other
   * three are provider render-lifecycle gates with no headless equivalent.
   *
   * `listAccounts()` (`GET /accounts`) and `getUsersByIds()`
   * (`POST /users/by-ids`) are private; calling either before cold-boot restore
   * plants the token 401s → `HttpService` clears the bearer + emits
   * `onTokensChanged(null)` → the app signs out. Every graph/profile fetch gates
   * on this.
   */
  private isAuthenticated(): boolean {
    return Boolean(this.oxyServices.getAccessToken());
  }

  /**
   * Reconcile the account graph against the current auth-readiness edge. On the
   * signed-out → signed-in edge fetch the graph ONCE; on signed-in → signed-out
   * drop it and re-project device-only. A no-op when readiness is unchanged, so
   * a burst of token events / device pushes cannot restart the fetch — and a
   * failed `listAccounts()` never flips the edge, so it cannot re-trigger itself
   * (no retry storm).
   */
  private reconcileAuth(): void {
    const authed = this.isAuthenticated();
    if (authed === this.authed) return;
    this.authed = authed;
    if (authed) {
      void this.refresh();
      return;
    }
    // Signed out: the graph is no longer fetchable/switchable — drop it and
    // re-project from the device session set alone.
    this.graph = [];
    this.error = null;
    this.loading = false;
    this.emit();
  }

  // =========================================================================
  // View actions
  // =========================================================================

  /** Set the dialog view directly. */
  setView(view: AccountDialogView): void {
    if (this.view === view) return;
    this.view = view;
    // A `'completed'` flow owns no timers, socket, popup, or token — it is only
    // the terminal "Identity confirmed" the finished surface showed. Moving to
    // another view is a NEW intention, so drop it; otherwise a later `add()`
    // would open on the previous sign-in's terminal state.
    if (this.signIn.phase === 'completed') {
      this.signIn = IDLE_SIGN_IN;
    }
    this.emit();
  }

  /** Switch to the "add account" view (the sign-in entry chooser). */
  add(): void {
    this.setView('add');
  }

  /** Switch to the "create account" view (passkey / Commons signup entry). */
  startSignup(): void {
    this.setView('signup');
  }

  // =========================================================================
  // Account list
  // =========================================================================

  /**
   * Reload the account graph and per-account profiles, then re-project. Safe to
   * call repeatedly; concurrent calls are reconciled by a sequence guard so a
   * slow earlier fetch never overwrites a newer result.
   */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;

    // Never hit the private `listAccounts()` while signed out: at cold boot the
    // bearer is not planted yet, so the call 401s → `HttpService` clears the
    // token and signs the user out. Re-project from the device session set alone
    // (`projectSwitchableAccounts` works from `SessionClient` state) and stop.
    if (!this.isAuthenticated()) {
      this.graph = [];
      this.loading = false;
      this.error = null;
      this.emit();
      return;
    }

    const hadAccounts = this.snapshot.accounts.length > 0;
    this.loading = !hadAccounts;
    this.error = null;
    this.emit();

    // The directory (ADR 0002) — the read model that replaces the union below.
    // Both lanes run while consumers migrate, which is the cost of not breaking
    // every switcher in one commit; the flat half goes when they have moved.
    // A failure here is never fatal: the compatibility projection still renders
    // from device state, so a directory outage degrades rather than blanks.
    try {
      await this.sessionClient.refreshDirectory();
    } catch (error) {
      if (extractErrorStatus(error) === 401) {
        logger.debug('[AccountDialogController] directory unauthorized (signed out)', { component: 'AccountDialogController' }, error);
      } else {
        logger.warn('[AccountDialogController] directory refresh failed', { component: 'AccountDialogController' }, error);
      }
    }
    if (seq !== this.refreshSeq) return; // superseded by a newer refresh

    let graph: AccountNode[] = this.graph;
    try {
      graph = await this.oxyServices.listAccounts();
    } catch (error) {
      // A 401 here is the EXPECTED signed-out edge, not a failure: the bearer was
      // stale/revoked, so `HttpService` already cleared it and emitted
      // `onTokensChanged(null)`, which drops the graph via `reconcileAuth`. Log at
      // debug and leave the dialog error-free — a signed-out device with zero
      // accounts is a normal state, not a warning. Any other error (network, 5xx,
      // malformed) IS unexpected: surface it and warn while keeping the prior graph
      // so device rows still render.
      if (extractErrorStatus(error) === 401) {
        logger.debug('[AccountDialogController] listAccounts unauthorized (signed out)', { component: 'AccountDialogController' }, error);
      } else {
        this.error = errorMessage(error);
        logger.warn('[AccountDialogController] listAccounts failed', { component: 'AccountDialogController' }, error);
      }
    }
    if (seq !== this.refreshSeq) return; // superseded by a newer refresh

    this.graph = graph;
    await this.loadProfiles(seq);
    if (seq !== this.refreshSeq) return;

    this.loading = false;
    this.emit();
  }

  /**
   * Fetch profiles for any account id (device set ∪ graph) not yet resolved.
   * Cheap no-op when everything is already hydrated — used from the session
   * subscription so a newly-added device account gets a name/avatar.
   */
  private async ensureProfiles(): Promise<void> {
    // `getUsersByIds` is private — skip the whole path while signed out.
    if (!this.isAuthenticated()) return;
    const ids = switchableAccountIds(this.sessionClient.getState(), this.graph);
    if (ids.every((id) => this.profilesById.has(id))) return;
    await this.loadProfiles(this.refreshSeq);
    this.emit();
  }

  private async loadProfiles(seq: number): Promise<void> {
    // `getUsersByIds` (`POST /users/by-ids`) is a private call — never issue it
    // while signed out (the 401 → sign-out cascade). Callers already gate; this
    // guards the network chokepoint too (e.g. the token was cleared mid-refresh).
    if (!this.isAuthenticated()) return;
    const ids = switchableAccountIds(this.sessionClient.getState(), this.graph);
    if (ids.length === 0) return;
    let profiles: User[] = [];
    try {
      profiles = await this.oxyServices.getUsersByIds(ids);
    } catch (error) {
      // A 401 is the EXPECTED signed-out edge (stale/cleared bearer) — log at debug.
      // `getUsersByIds` already swallows per-chunk failures and returns `[]`, so any
      // OTHER error here is an unexpected total failure worth a warn. Either way keep
      // the prior profile map.
      if (extractErrorStatus(error) === 401) {
        logger.debug('[AccountDialogController] getUsersByIds unauthorized (signed out)', { component: 'AccountDialogController' }, error);
      } else {
        logger.warn('[AccountDialogController] getUsersByIds failed', { component: 'AccountDialogController' }, error);
      }
      return;
    }
    if (seq !== this.refreshSeq) return; // superseded
    const next = new Map(this.profilesById);
    for (const profile of profiles) {
      next.set(profile.id, profile);
    }
    this.profilesById = next;
  }

  // =========================================================================
  // Switching (uniform switch model — reuses the existing SDK primitives)
  // =========================================================================

  /**
   * Switch the active account to `accountId`.
   *
   * Uniform switch model, mirroring the SDK's existing path — NOT a new switch
   * mechanism:
   *   - already on this device → `SessionClient.switchAccount` (device-first
   *     switch of `/session/device/switch`);
   *   - a graph account not yet on the device (first entry) →
   *     `oxyServices.switchToAccount` mints + plants a real session and the
   *     server registers it into the device set, then it is committed
   *     (`commitSession` when supplied, else `SessionClient.registerAndActivate`).
   *
   * The resulting device-state change flows back through the `SessionClient`
   * subscription, which re-projects the active row. Concurrent switches are
   * ignored while one is in flight.
   */
  async switchTo(accountId: string): Promise<boolean> {
    if (this.switchingAccountId) return false;
    this.switchingAccountId = accountId;
    this.error = null;
    this.emit();
    try {
      const state = this.sessionClient.getState();
      const onDevice = state?.accounts.some((account) => account.accountId === accountId) ?? false;
      if (onDevice) {
        await this.sessionClient.switchAccount(accountId);
      } else {
        const result = await this.oxyServices.switchToAccount(accountId);
        if (!result?.user || !result?.sessionId) {
          throw new Error('Account switch did not return a valid session');
        }
        await this.commitAuthorizedSession(
          {
            sessionId: result.sessionId,
            deviceId: result.deviceId,
            expiresAt: result.expiresAt,
            user: result.user,
            accessToken: result.accessToken,
          },
          result.user,
          // A switch is IN-PLACE: use the switch commit funnel (not sign-in).
          // Cross-tab/app propagation rides the server's `session_state` socket
          // broadcast, not a navigation.
          { fromSwitch: true },
        );
      }
      // Re-project + refetch immediately; the subscription also fires.
      await this.refresh();
      return true;
    } catch (error) {
      this.error = errorMessage(error);
      return false;
    } finally {
      this.switchingAccountId = null;
      this.emit();
    }
  }

  /**
   * Activate one `principal acting as account` context — the ADR 0002 switch,
   * and the one that can express what {@link switchTo} cannot: WHICH person's
   * route to a shared organization to become.
   *
   * There is no on-device/graph fork here. That fork exists in `switchTo`
   * because the flat model has no row for an account the caller may act as but
   * has never entered, so the first entry has to mint through a different
   * endpoint. The directory has a row for both, and `POST /session/device/
   * activate` reuses or mints the delegated session server-side, so one call
   * covers both cases.
   *
   * A context id is not stable across a removal, so a stale one is an ordinary
   * outcome rather than a bug: the server answers 404 or 403, heals the row, and
   * the refresh below re-reads a directory that no longer offers it.
   */
  async activateContext(contextId: string): Promise<boolean> {
    if (this.activatingContextId) return false;
    this.activatingContextId = contextId;
    this.error = null;
    this.emit();
    try {
      await this.sessionClient.activateContext(contextId);
      await this.refresh();
      return true;
    } catch (error) {
      this.error = errorMessage(error);
      return false;
    } finally {
      this.activatingContextId = null;
      this.emit();
    }
  }

  // =========================================================================
  // Sign in with Oxy (device flow — shared keychain, else cross-device QR)
  // =========================================================================

  /**
   * Start "Sign in with Oxy". Native devices with a shared identity mint a
   * session silently (`signInWithSharedIdentity`); everything else (web, or a
   * native device without a shared identity) falls through to the cross-device
   * QR handoff.
   */
  async signInWithOxy(): Promise<void> {
    this.setView('qr');
    this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'starting' });
    try {
      const session = await this.oxyServices.signInWithSharedIdentity();
      if (session) {
        await this.completeSignIn(session, session.user);
        return;
      }
    } catch (error) {
      // Shared-key mint failed — log and fall through to the QR handoff rather
      // than dead-ending the sign-in.
      logger.warn('[AccountDialogController] signInWithSharedIdentity failed', { component: 'AccountDialogController' }, error);
    }
    await this.showQr();
  }

  /**
   * Begin (or restart) the cross-device QR handoff: create a device-flow
   * session, surface its `authorizeCode` + `qrPayload`, and poll for approval.
   * On approval the secret token is exchanged (`claimSessionByToken`) and the
   * session committed. Requires `clientId`.
   */
  async showQr(): Promise<void> {
    this.cancelSignIn();
    this.setView('qr');
    await this.startDeviceFlowSession({ deliver: true });
  }

  /**
   * Web-only: "Sign in with a passkey" on a non-Oxy origin cannot run the
   * WebAuthn ceremony locally — a credential minted with `WEBAUTHN_RP_ID=oxy.so`
   * can only be asserted from `oxy.so`/a subdomain/loopback, a browser-enforced
   * boundary `isOxyRpOrigin()` (consumer-side) already gates on. Instead, open
   * a popup at the auth.oxy.so passkey hub, scoped to the SAME device-flow
   * session {@link showQr} would create (same `authorizeCode`/`sessionToken`
   * pair), and let the SAME poll/socket/claim engine complete it once the hub
   * authorizes the session (`POST /auth/session/authorize-code/:authorizeCode`,
   * bearer-authed, server-side — this method never sees or transmits the
   * secret `sessionToken`).
   *
   * The popup MUST be opened synchronously, before any `await`, or the
   * browser's popup blocker loses the click-gesture attribution and silently
   * blocks it — so {@link openPopup} is invoked as the very first step, before
   * the device-flow session (which needs an async call) even exists. If the
   * popup is blocked (or no `openPopup` was injected), this falls back to
   * `showQr`'s plain QR rendering — no dead end.
   */
  async startPasskeyHubSignIn(): Promise<void> {
    this.cancelSignIn();
    this.setView('qr');
    const popup = this.openPopup?.() ?? null;
    if (!popup) {
      await this.startDeviceFlowSession({ deliver: true });
      return;
    }
    // The hub popup IS the primary surface here, chosen explicitly by the user —
    // so this flow does NOT run automatic Commons delivery (ringing the user's
    // phone because they asked for a passkey would be exactly the "menu of
    // methods" the one-primary-action rule forbids). The underlying request is
    // the same `AuthSession`, and its Commons route stays the QR the view
    // renders beneath the popup.
    const handle = await this.startDeviceFlowSession({ deliver: false });
    if (!handle) {
      popup.close();
      return;
    }
    // The user may have closed the popup during the async session creation
    // above, before any watcher was attached to catch it — guard rather than
    // navigate a dead window (browsers vary on whether that throws).
    if (popup.closed) {
      this.failSignIn('Sign-in was cancelled.');
      return;
    }
    this.activePopup = popup;
    popup.location.href = `${this.hubBaseUrl}/hub-passkey?code=${encodeURIComponent(handle.authorizeCode)}`;
    this.watchPopup(popup);
  }

  /**
   * Shared device-flow session creation for both {@link showQr} (renders the
   * QR) and {@link startPasskeyHubSignIn} (also opens the hub popup) — the
   * same `startCommonsSignIn` → poll/socket wiring either way. Returns the
   * handle on success (already reflected in `signIn`), or `null` on failure
   * (already set as `signIn.error`).
   *
   * @param opts.deliver - Whether to run automatic Commons delivery selection
   *   ({@link resolveDeliveryRoute}). `true` for the normal one-primary-action
   *   entry; `false` when the caller already owns the primary surface (the
   *   passkey hub popup), where the request's Commons route is simply the QR.
   */
  private async startDeviceFlowSession(opts: { deliver: boolean }): Promise<CommonsSignInHandle | null> {
    if (!this.clientId) {
      this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'error', error: 'This app is not configured for sign-in (missing clientId).' });
      return null;
    }
    this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'starting' });
    try {
      const handle = await this.oxyServices.startCommonsSignIn({ clientId: this.clientId });
      this.signInToken = handle.sessionToken;
      this.setSignIn({
        ...IDLE_SIGN_IN_FACTS,
        phase: 'waiting',
        authorizeCode: handle.authorizeCode,
        qrPayload: handle.qrPayload,
        expiresAt: handle.expiresAt,
        // No route yet: the surface shows "Preparing request" until the primary
        // route is resolved below. It is never guessed in the meantime.
        route: opts.deliver ? null : 'qr',
      });
      // Primary path: an instant `auth_update` wake over the `/auth-session`
      // socket. The poll below is only the fallback for when the socket can't
      // connect, so it now runs at the slow fallback cadence.
      this.openAuthSessionSocket(handle.sessionToken);
      this.scheduleNextPoll(handle.sessionToken);
      if (opts.deliver) {
        // Non-blocking on purpose: the QR/authorizeCode are already renderable
        // and the popup caller can navigate immediately, while the route (a
        // local probe plus at most one delivery round-trip) resolves behind it.
        void this.resolveDeliveryRoute(handle);
      }
      return handle;
    } catch (error) {
      this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'error', error: errorMessage(error) });
      return null;
    }
  }

  /**
   * Choose and carry out the ONE primary delivery route for the active request
   * (issue #691, "Automatic delivery selection").
   *
   * The controller gathers the facts — is a verified Commons link openable on
   * THIS device, and how many known Commons installations did Oxy actually push
   * to — and hands them to the pure {@link selectCommonsDelivery}. The selector
   * owns the decision; this method owns only the observations and the single
   * action the chosen route implies. It never cascades: a route that yields
   * nothing resolves to QR *before* a route is chosen, never after.
   */
  private async resolveDeliveryRoute(handle: CommonsSignInHandle): Promise<void> {
    if (!this.isAwaitingApproval(handle.sessionToken)) return;

    // Fact 1 — a VERIFIED Commons link openable on this very device. Native
    // only; on web `commonsAvailability` stays `'unknown'` (a browser cannot be
    // asked whether a custom scheme is registered) and this is simply `false`.
    if (
      this.canOpenApp &&
      (this.commonsAvailability === 'unknown' || this.commonsAvailability === 'checking')
    ) {
      await this.resolveCommonsAvailability();
      if (!this.isAwaitingApproval(handle.sessionToken)) return;
    }
    const commonsAvailable = this.commonsAvailability === 'available';

    // Fact 2 — how many known Commons installations the server pushed to.
    const pushTargets = await this.deliverToKnownCommons(handle.authorizeCode, commonsAvailable);
    if (!this.isAwaitingApproval(handle.sessionToken)) return;

    const route = selectCommonsDelivery({ platform: this.platform, commonsAvailable, pushTargets });
    // The only route that has an action to perform on this device — and the only
    // one that can fail here. `'await-push'` was already dispatched server-side;
    // `'qr'` is rendered by the surface from `qrPayload`.
    const routeFailed = route === 'open-commons' ? !this.openCommonsLink(handle.qrPayload) : false;
    this.patchSignIn({ route, routeFailed });
  }

  /**
   * Whether `sessionToken` is still THE request this surface is waiting on.
   *
   * Guards every step of the asynchronous route resolution: a cancelled,
   * superseded, failed, or already-approved flow must neither open Commons nor
   * mutate the surface — an approval that lands mid-resolution would otherwise
   * be followed by a pointless app switch.
   */
  private isAwaitingApproval(sessionToken: string): boolean {
    return this.signInToken === sessionToken && this.signIn.phase === 'waiting';
  }

  /**
   * Ask Oxy to deliver the pending request to the identity's known Commons
   * installations, returning how many it reached (`0` when delivery is not
   * applicable, not permitted, or reached nobody).
   *
   * Two hard rules, both from the issue:
   *  - **Never push from an unauthenticated surface.** `deliverCommonsSignIn`
   *    is bearer-required precisely because a request that merely carries a
   *    typed-in username must never be able to ring somebody's phone. Without a
   *    planted bearer the call is not made AT ALL — not made-and-failed.
   *  - **Zero targets and a failed delivery are the same normal outcome.** Both
   *    return `0`, which resolves the primary route to QR silently. Neither is
   *    surfaced as an error: there is nothing the user did wrong and nothing for
   *    them to fix.
   */
  private async deliverToKnownCommons(authorizeCode: string, commonsAvailable: boolean): Promise<number> {
    // Route 1 (mobile with a verified local Commons link) reaches the identity
    // on this very device — pushing as well would notify a second surface for a
    // request the user is about to confirm here.
    if (this.platform === 'mobile' && commonsAvailable) return 0;
    if (!this.isAuthenticated()) return 0;
    try {
      const result = await this.oxyServices.deliverCommonsSignIn(authorizeCode);
      // `delivered: false` with `targets > 0` is a transport failure, not a
      // reachable install — the shared helper owns that rule so the surface
      // can never park a user on "check your phone" for a push that failed.
      return pushTargetsFromDelivery(result);
    } catch (error) {
      logger.debug(
        '[AccountDialogController] Commons delivery unavailable (QR route)',
        { component: 'AccountDialogController' },
        error,
      );
      return 0;
    }
  }

  /**
   * Open the verified Commons link for the `'open-commons'` route. Returns
   * whether the navigation was actually handed off, so a missing opener or a
   * throwing one becomes an observable `routeFailed` instead of a silent dead
   * end the user stares at.
   */
  private openCommonsLink(qrPayload: string): boolean {
    if (!this.openUrl) return false;
    try {
      this.openUrl(qrPayload);
      return true;
    } catch (error) {
      logger.debug(
        '[AccountDialogController] Commons deep link failed',
        { component: 'AccountDialogController' },
        error,
      );
      return false;
    }
  }

  /**
   * Poll {@link PopupWindowHandle.closed} so a user who dismisses the hub
   * popup without completing sign-in gets prompt feedback (there is no DOM
   * event for a cross-origin popup closing — polling is the only mechanism).
   * Cleared by {@link closeActivePopup}, which every sign-in exit path already
   * calls.
   */
  private watchPopup(popup: PopupWindowHandle): void {
    this.clearPopupWatchTimer();
    this.popupWatchTimer = setInterval(() => {
      if (!popup.closed) return;
      this.clearPopupWatchTimer();
      if (this.signIn.phase === 'starting' || this.signIn.phase === 'waiting') {
        // Closing the surface cancels the REQUEST too, not just this listener.
        const pendingCode = this.signIn.authorizeCode;
        this.failSignIn('Sign-in was cancelled.');
        if (pendingCode) {
          void this.withdrawRequest(pendingCode);
        }
      }
    }, 1000);
  }

  private clearPopupWatchTimer(): void {
    if (this.popupWatchTimer !== null) {
      clearInterval(this.popupWatchTimer);
      this.popupWatchTimer = null;
    }
  }

  /** Tear down the popup watch timer and close the popup, if any. Idempotent. */
  private closeActivePopup(): void {
    this.clearPopupWatchTimer();
    const popup = this.activePopup;
    this.activePopup = null;
    if (!popup || popup.closed) return;
    try {
      popup.close();
    } catch (error) {
      logger.debug('[AccountDialogController] popup close failed', { component: 'AccountDialogController' }, error);
    }
  }

  /**
   * Resolve whether Commons is installed on this device via the injected
   * `canOpenApp` probe, updating {@link commonsAvailability} as durable,
   * observable snapshot state. Native only — a no-op when `canOpenApp` was
   * not injected (web), where `commonsAvailability` stays `'unknown'` forever
   * and the QR view renders unconditionally (no gating).
   *
   * Replaces the old `maybeOpenCommons` fire-and-forget probe, whose outcome
   * was only ever reflected by whether Commons silently opened — a probe
   * failure or "not installed" answer was swallowed into a debug log with no
   * way for the UI to react. `commonsAvailability` fixes that.
   */
  private async resolveCommonsAvailability(): Promise<void> {
    if (!this.canOpenApp) return;
    this.commonsAvailability = 'checking';
    this.emit();
    let available = false;
    try {
      available = await this.canOpenApp(COMMONS_APP_SCHEME);
    } catch (error) {
      logger.debug(
        '[AccountDialogController] Commons availability probe failed',
        { component: 'AccountDialogController' },
        error,
      );
      available = false; // fail-closed — treat a probe error as "not installed"
    }
    this.commonsAvailability = available ? 'available' : 'unavailable';
    this.emit();
  }

  /**
   * Tear down the active sign-in device flow (timers + socket + popup + token),
   * WITHDRAW the request server-side, and reset to idle.
   *
   * Cancellation has to converge in both directions: the surface closing must
   * cancel the request, not just stop listening to it. Without the withdrawal a
   * dismissed QR would stay approvable until it expired, so a later scan of a
   * stale code could authorize a session nobody is waiting for.
   */
  cancelSignIn(): void {
    // Capture before the teardown clears it, and only for a request that can
    // still be approved — a completed/failed flow has nothing to withdraw.
    const pendingCode =
      this.signIn.phase === 'starting' || this.signIn.phase === 'waiting'
        ? this.signIn.authorizeCode
        : null;
    this.clearPollTimer();
    this.closeAuthSessionSocket();
    this.closeActivePopup();
    this.signInToken = null;
    if (this.signIn !== IDLE_SIGN_IN) {
      this.setSignIn(IDLE_SIGN_IN_FACTS);
    }
    if (pendingCode) {
      void this.withdrawRequest(pendingCode);
    }
  }

  /**
   * Best-effort server-side withdrawal of a request this surface abandoned
   * (`POST /auth/session/deny/:authorizeCode`). Fire-and-forget by design: the
   * local teardown already happened, and a race with an approval that just
   * landed legitimately rejects here — neither outcome is worth surfacing.
   */
  private async withdrawRequest(authorizeCode: string): Promise<void> {
    try {
      await this.oxyServices.denyCommonsSignIn(authorizeCode);
    } catch (error) {
      logger.debug(
        '[AccountDialogController] request withdrawal failed',
        { component: 'AccountDialogController' },
        error,
      );
    }
  }

  // =========================================================================
  // Internal sign-in helpers
  // =========================================================================

  private scheduleNextPoll(sessionToken: string): void {
    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      void this.pollOnce(sessionToken);
    }, this.pollIntervalMs);
  }

  /**
   * Run one status check + (on approval) claim. Triggered by the fallback timer
   * AND by the `/auth-session` socket's `auth_update` wake, so it is guarded
   * against concurrent entry: whichever fires first claims the single-use token;
   * the other no-ops. The `auth_update` payload is never trusted — this always
   * re-checks the authoritative status via `pollCommonsSignIn`.
   */
  private async pollOnce(sessionToken: string): Promise<void> {
    // A superseded / cancelled flow must not act; a poll already running owns the claim.
    if (this.signInToken !== sessionToken || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const expiresAt = this.signIn.expiresAt;
      if (typeof expiresAt === 'number' && Date.now() > expiresAt) {
        this.failSignIn('Session expired. Please try again.');
        return;
      }
      try {
        const status = await this.oxyServices.pollCommonsSignIn(sessionToken);
        if (this.signInToken !== sessionToken) return; // cancelled mid-request
        // Delivery PROGRESS first: it is reported alongside every status, and
        // recording it before the terminal branches means a poll that also
        // carries the approval still leaves an honest trail behind it.
        this.recordDeliveryProgress(status.pushSentAt, status.openedAt);
        const purpose = status.purpose === 'oauth_authorization' ? 'oauth_authorization' : 'device_sign_in';
        if (status.authorized && purpose === 'oauth_authorization') {
          // OAuth-bound sessions mint no sessionId on approval — they finalize
          // into an authorization code. The account dialog only starts device
          // sign-in today; stop rather than poll until expiry.
          this.failSignIn('This sign-in flow cannot be completed here. Use the app\'s OAuth sign-in instead.');
          return;
        }
        if (status.authorized && status.sessionId) {
          this.clearPollTimer();
          await this.claimAndComplete(status.sessionId, sessionToken);
          return;
        }
        if (status.status === 'cancelled') {
          this.failSignIn('Authorization was denied.');
          return;
        }
        if (status.status === 'expired') {
          this.failSignIn('Session expired. Please try again.');
          return;
        }
      } catch (error) {
        // Transient poll error — the next tick retries. Logged, never thrown.
        logger.debug('[AccountDialogController] poll error (will retry)', { component: 'AccountDialogController' }, error);
      }
      if (this.signInToken === sessionToken) {
        this.scheduleNextPoll(sessionToken);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Record server-reported delivery progress on the active flow.
   *
   * Monotone and additive: a timestamp is only ever adopted, never replaced or
   * cleared, so an older API build (or a partial payload) that omits a field can
   * at most fail to advance the surface — it can never walk it backwards.
   * Emits only on a real change, so a steady poll does not churn the snapshot.
   */
  private recordDeliveryProgress(pushSentAt: string | null, openedAt: string | null): void {
    const nextPushSentAt = this.signIn.pushSentAt ?? pushSentAt ?? null;
    const nextOpenedAt = this.signIn.openedAt ?? openedAt ?? null;
    if (nextPushSentAt === this.signIn.pushSentAt && nextOpenedAt === this.signIn.openedAt) return;
    this.patchSignIn({ pushSentAt: nextPushSentAt, openedAt: nextOpenedAt });
  }

  private async claimAndComplete(sessionId: string, sessionToken: string): Promise<void> {
    this.patchSignIn({ phase: 'authorized' });
    let claimed: {
      accessToken: string;
      sessionId: string;
      deviceId: string;
      expiresAt: string;
      user: User;
      deviceSecret?: string;
    };
    try {
      claimed = await this.oxyServices.claimSessionByToken(sessionToken);
    } catch (error) {
      this.failSignIn(errorMessage(error));
      return;
    }
    if (!claimed?.accessToken || !claimed.user) {
      this.failSignIn('Authorization succeeded but the session could not be claimed. Please try again.');
      return;
    }
    // `SessionLoginResponse.user` is the minimal session-carried shape; the claim
    // returns the full `User` (avatar is `string | null | undefined`). Normalize
    // rather than widening the minimal shape to accept `null`.
    const minimalUser: MinimalUserData = {
      id: claimed.user.id,
      username: claimed.user.username,
      name: claimed.user.name,
      avatar: claimed.user.avatar ?? undefined,
    };
    try {
      await this.completeSignIn(
        {
          sessionId: claimed.sessionId || sessionId,
          deviceId: claimed.deviceId ?? '',
          expiresAt: claimed.expiresAt ?? '',
          user: minimalUser,
          accessToken: claimed.accessToken,
          ...(claimed.deviceSecret ? { deviceSecret: claimed.deviceSecret } : {}),
        },
        minimalUser,
      );
    } catch (error) {
      this.failSignIn(errorMessage(error));
    }
  }

  /**
   * Commit an authorized session, notify, and return to the account list. Shared
   * by the shared-key, QR, and mint-switch paths so they cannot drift.
   */
  private async completeSignIn(
    session: SessionLoginResponse,
    user: MinimalUserData,
  ): Promise<void> {
    await this.commitAuthorizedSession(session, user);
    this.signInToken = null;
    this.clearPollTimer();
    this.closeAuthSessionSocket();
    this.closeActivePopup();
    // Terminal SUCCESS, not idle: the surface gets one honest frame to show
    // "Identity confirmed" before it closes. Cleared on the next view change.
    this.signIn = COMPLETED_SIGN_IN;
    this.view = 'accounts';
    this.emit();
    this.onSignedIn?.(user);
    await this.refresh();
  }

  /**
   * Register a token-planted session into the device set. Prefers the
   * consumer's commit funnel (durable persist + hydration); falls back to
   * `SessionClient.registerAndActivate` (registration + activation only).
   *
   * A SWITCH (`opts.fromSwitch`) uses the IN-PLACE `commitSwitchedSession` funnel;
   * a SIGN-IN uses `commitSession`. When the switch funnel is not wired it falls
   * back to the sign-in funnel, then to `registerAndActivate`.
   */
  private async commitAuthorizedSession(
    session: SessionLoginResponse,
    user: MinimalUserData,
    opts?: { fromSwitch?: boolean },
  ): Promise<void> {
    const commit = opts?.fromSwitch
      ? this.commitSwitchedSession ?? this.commitSession
      : this.commitSession;
    if (commit) {
      await commit(session);
    } else {
      await this.sessionClient.registerAndActivate(user.id);
    }
  }

  private failSignIn(message: string): void {
    this.clearPollTimer();
    this.closeAuthSessionSocket();
    this.closeActivePopup();
    this.signInToken = null;
    this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'error', error: message });
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // =========================================================================
  // /auth-session socket (instant QR approval wake — replaces 3s polling)
  // =========================================================================

  /**
   * Subscribe the active QR flow to the `/auth-session` namespace so the API's
   * `auth_update` event wakes {@link pollOnce} the instant the approval lands.
   *
   * The join is keyed by the secret `sessionToken` (the server's `auth:<token>`
   * room, joined by emitting `join`) and re-issued on every (re)connect so it
   * survives socket drops. `auth_update` is treated as a pure SIGNAL — the payload
   * is never trusted; `pollOnce` re-checks the authoritative status and claims.
   *
   * No-op (poll-only) when no `socketFactory` was injected (web without a bundled
   * `io`, headless/core usage, tests). The namespace needs no auth.
   */
  private openAuthSessionSocket(sessionToken: string): void {
    this.closeAuthSessionSocket();
    if (!this.socketFactory) return;
    let socket: MinimalSocket;
    try {
      socket = this.socketFactory(`${this.oxyServices.getBaseURL()}${AUTH_SESSION_NAMESPACE}`, {
        transports: ['websocket'],
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: Number.POSITIVE_INFINITY,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
      });
    } catch (error) {
      // Socket unavailable — the fallback poll still completes the flow.
      logger.debug('[AccountDialogController] auth-session socket create failed (poll fallback)', { component: 'AccountDialogController' }, error);
      return;
    }
    const join = (): void => {
      if (this.signInToken !== sessionToken) return;
      try {
        socket.emit('join', sessionToken);
      } catch (error) {
        logger.debug('[AccountDialogController] auth-session join failed', { component: 'AccountDialogController' }, error);
      }
    };
    socket.on('connect', join);
    if (socket.connected) join();
    socket.on('auth_update', () => {
      if (this.signInToken !== sessionToken) return;
      // Pure wake signal — re-check the authoritative status + claim the poll would have.
      void this.pollOnce(sessionToken);
    });
    this.authSessionSocket = socket;
  }

  /** Tear down the `/auth-session` socket, if any. Idempotent. */
  private closeAuthSessionSocket(): void {
    const socket = this.authSessionSocket;
    if (!socket) return;
    this.authSessionSocket = null;
    try {
      socket.off('auth_update');
      socket.off('connect');
      socket.disconnect();
    } catch (error) {
      logger.debug('[AccountDialogController] auth-session socket close failed', { component: 'AccountDialogController' }, error);
    }
  }

  // =========================================================================
  // Snapshot plumbing
  // =========================================================================

  /**
   * Replace the device-flow state from its FACTS, re-deriving `progress`. The
   * only writer of `this.signIn` besides the two terminal constants — which is
   * what keeps `progress` impossible to set by hand, and therefore impossible
   * to advance without a fact behind it.
   */
  private setSignIn(facts: SignInFlowFacts): void {
    this.signIn = { ...facts, progress: deriveSignInProgress(facts) };
    this.emit();
  }

  /** Update a subset of the device-flow facts, re-deriving `progress`. */
  private patchSignIn(patch: Partial<SignInFlowFacts>): void {
    const {
      phase,
      authorizeCode,
      qrPayload,
      expiresAt,
      error,
      route,
      routeFailed,
      pushSentAt,
      openedAt,
    } = this.signIn;
    this.setSignIn({
      phase,
      authorizeCode,
      qrPayload,
      expiresAt,
      error,
      route,
      routeFailed,
      pushSentAt,
      openedAt,
      ...patch,
    });
  }

  private computeSnapshot(): AccountDialogSnapshot {
    const state = this.sessionClient.getState();
    const directory = this.sessionClient.getDirectory();
    return {
      view: this.view,
      directory,
      activeContext: resolveActiveContext(directory),
      accounts: projectSwitchableAccounts({
        state,
        graph: this.graph,
        profilesById: this.profilesById,
        locale: this.locale,
        resolveAvatarUrl: (avatar) =>
          (avatar ? this.oxyServices.getFileDownloadUrl(avatar, 'thumb') : undefined),
      }),
      activeAccountId: state?.activeAccountId ?? null,
      loading: this.loading,
      error: this.error,
      switchingAccountId: this.switchingAccountId,
      activatingContextId: this.activatingContextId,
      signIn: this.signIn,
      commonsAvailability: this.commonsAvailability,
    };
  }

  /** Recompute the snapshot and notify subscribers. */
  private emit(): void {
    this.snapshot = this.computeSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch (error) {
        logger.error('[AccountDialogController] subscriber threw', error);
      }
    }
  }
}

/** Factory mirroring `createSessionClient`, for ergonomic wiring by consumers. */
export function createAccountDialogController(
  options: AccountDialogControllerOptions,
): AccountDialogController {
  return new AccountDialogController(options);
}
