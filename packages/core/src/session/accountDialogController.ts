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
 *   - the device DIRECTORY (ADR 0002) — the server-authoritative read model of
 *     who is on this device and what each of them may act as, read through
 *     `SessionClient.refreshDirectory()`. It is not assembled here: the client
 *     holds one caller's account graph and cannot enumerate another principal's,
 *     so switchability is the server's answer and the controller only reads it;
 *   - the dialog `view` state machine (`accounts` | `signin` | `qr` | `add` |
 *     `signup`);
 *   - `activateContext` (the ADR 0002 switch, keyed on the `principal acting as
 *     account` pair) and the two removals an account id cannot name —
 *     `signOutContext` and `signOutPrincipal`;
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
 *
 * Sign-in is passkey (WebAuthn) or the Commons QR / shared-keychain handoff —
 * password, social login, and 2FA were removed ecosystem-wide. Account
 * creation (`signup` view) is the same two identity backends: a passkey
 * ceremony on web, or a Commons-created identity.
 *
 * The controller owns NO surface PRESENTATION: whether the account dialog is
 * mounted, visible, or dismissed is the job of the shared surface stack
 * (`@oxy.so/services` presents the `AccountDialog` surface into `@oxy.so/bloom`'s
 * stack). This is a headless state machine only — it exposes `setView` /
 * `add` / `startSignup` (the view axis) and `cancelSignIn` (device-flow
 * teardown), never an `open` / `close` / `visible`.
 */

import type { DeviceDirectory } from '@oxy.so/contracts';
import type { OxyServices } from '../OxyServices';
import type { SessionLoginResponse, MinimalUserData } from '../models/session';
import type { User } from '../models/interfaces';
import { logger } from '../logger';
import { extractErrorStatus } from '../utils/errorUtils';
import type { SessionClient } from './SessionClient';
import { getSocketIO, type MinimalSocket, type SocketIOFactory } from './socketLoader';
import { resolveActiveContext, type DeviceContext } from './deviceDirectory';
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
 * WHY a sign-in attempt ended in `'error'` — a machine-readable reason the UI
 * turns into localized copy (the controller ships no user-facing prose).
 *
 *  - `'denied'` — the approver declined the request in Commons.
 *  - `'expired'` — the request outlived its server-authoritative expiry.
 *  - `'network'` — Oxy could not be reached (no response, timeout).
 *  - `'not-configured'` — the app has no registered `clientId`.
 *  - `'unsupported-flow'` — an OAuth-bound request, which this surface cannot finalize.
 *  - `'claim-failed'` — the request WAS approved, but the session could not be claimed.
 *  - `'unknown'` — anything else; the raw message stays on `error` for logs.
 */
export type SignInFailureReason =
  | 'denied'
  | 'expired'
  | 'network'
  | 'not-configured'
  | 'unsupported-flow'
  | 'claim-failed'
  | 'unknown';

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
  /**
   * The raw, UNLOCALIZED failure message (diagnostics only), or `null`. A surface
   * renders {@link failure} instead — this string is English or a server message.
   */
  error: string | null;
  /** Why the attempt failed, set together with `phase: 'error'`; `null` otherwise. */
  failure: SignInFailureReason | null;
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
  /**
   * Identity of the sign-in ATTEMPT this state belongs to — a counter that moves
   * whenever an attempt is started, cancelled, or the controller is destroyed.
   * Not a secret. It lets a surface treat "this attempt failed" as one event (a
   * re-notification of the same failure is not a second failure, while a new
   * attempt failing with the same message is).
   */
  attempt: number;
  /**
   * `true` when this attempt is the sign-in entry's EMBEDDED QR
   * ({@link AccountDialogController.startInlineQr}): a request the surface
   * started on its own, not one the person asked for. Its failures (an expired
   * code, above all) belong to that QR, which renews itself, and are not news
   * to report.
   */
  inline: boolean;
}

/**
 * The observable FACTS of a device flow — {@link SignInFlowState} minus the
 * values the controller derives. Every mutation of the flow goes through this
 * shape, which is what makes `progress` (and `attempt`) impossible to set by hand.
 */
type SignInFlowFacts = Omit<SignInFlowState, 'progress' | 'attempt' | 'inline'>;

/** How the current sign-in attempt was started — what "Try again" repeats. */
type SignInMethod = 'oxy' | 'qr' | 'inline-qr';

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
  /**
   * The current view. Never `'accounts'` without a session: the account menu
   * describes a signed-in account, so with no bearer the controller shows the
   * sign-in entry (`'signin'`) in its place.
   */
  view: AccountDialogView;
  /**
   * Where {@link AccountDialogController.back} leads from {@link view}, or
   * `null` when `view` is the dialog's first view (a back there closes the
   * dialog instead). Hosts show their back affordance from this, not from a
   * table of their own.
   */
  backView: AccountDialogView | null;
  /**
   * Whether THIS client is signed in: a bearer is planted.
   *
   * Not the same question as "does the directory list anyone". The directory is
   * the DEVICE's, and a device can go on listing a shared identity (Commons, or a
   * sibling app) after this app signed out. A host names its sign-in entry, and
   * whether a listed account reads as the current one, from this — never from
   * the directory's size.
   */
  hasSession: boolean;
  /**
   * The server-authoritative device directory — principals and the contexts
   * each may act as (ADR 0002) — or `null` before the first read.
   *
   * The ONE read model a switcher renders. The flat list this replaced was
   * keyed by account id, so on a device holding two people it could show one
   * route to a shared organization and never both.
   */
  directory: DeviceDirectory | null;
  /** The active `principal acting as account` pair, actor and subject apart. */
  activeContext: DeviceContext | null;
  /** `true` while the first directory read is in flight with nothing to show. */
  loading: boolean;
  /** A human-readable directory error, or `null`. */
  error: string | null;
  /** The `contextId` of an in-flight activation, or `null`. */
  activatingContextId: string | null;
  /** The `contextId` of an in-flight context removal, or `null`. */
  removingContextId: string | null;
  /** The `principalId` of an in-flight principal removal, or `null`. */
  removingPrincipalId: string | null;
  /** The "Sign in with Oxy" device-flow state. */
  signIn: SignInFlowState;
  /** Whether Commons is installed on this device. See {@link CommonsAvailability}. */
  commonsAvailability: CommonsAvailability;
}

/**
 * What {@link AccountDialogController.chooseContext} did with a chosen row.
 *
 * - `'current'` — the row is already the active account; nothing to do.
 * - `'switched'` — the switch to the row happened (signed in; or signed out,
 *   after the silent sign-in landed on a different pair and the chosen one was
 *   then activated).
 * - `'signing-in'` — signed out: the row started "Continue with Oxy", and the
 *   sign-in flow (its own view, its own completion) owns what happens next —
 *   including closing the dialog, through `onSignedIn`.
 * - `'failed'` — the switch was attempted and failed (the reason is `error`).
 * - `'busy'` — another device mutation is in flight; the press was dropped.
 */
export type ContextChoiceOutcome = 'current' | 'switched' | 'signing-in' | 'failed' | 'busy';

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
  /**
   * Commit a freshly-authorized SIGN-IN session (device flow / shared identity)
   * into the host's session set — device-first registration + durable persist +
   * profile hydration. The consumer supplies its provider's commit path
   * (`useOxy().handleWebSession` / the auth-sdk equivalent). Called AFTER the SDK
   * has planted the access token. When omitted the controller falls back to
   * `SessionClient.registerAndActivate` (registration + activation only — no
   * provider-side durable persist/hydration).
   *
   * Sign-in is the only thing that commits a session here. An account SWITCH
   * used to mint one too, on first entry into a graph account; activation mints
   * the delegated session SERVER-side and hands back a bearer, so there is no
   * second commit funnel to keep in step with this one.
   */
  commitSession?: (session: SessionLoginResponse) => Promise<void>;
  /** Notified after a completed sign-in (bearer planted + session committed). */
  onSignedIn?: (user: MinimalUserData) => void;
  /**
   * QR device-flow FALLBACK poll interval in ms (default 12000). The primary
   * approval signal is the `/auth-session` socket's `auth_update` event (instant);
   * this slow poll is only the safety net for when the socket can't connect.
   */
  pollIntervalMs?: number;
  /**
   * Optional injected `socket.io-client` factory, primarily for tests. Without
   * one, the optional transport loads only when QR sign-in starts. The flow subscribes to the
   * `/auth-session` namespace for an INSTANT `auth_update` wake instead of relying
   * on the slow fallback poll. If the package is unavailable, the controller
   * silently degrades to poll-only.
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
  failure: null,
  route: null,
  routeFailed: false,
  pushSentAt: null,
  openedAt: null,
};

/**
 * Terminal SUCCESS facts: the session was claimed and committed. Holds no live
 * resources and no request handles — only the terminal progress the surface
 * shows ("Identity confirmed") before it closes.
 */
const COMPLETED_SIGN_IN_FACTS: SignInFlowFacts = { ...IDLE_SIGN_IN_FACTS, phase: 'completed' };

/** The full flow state for `facts`, stamped with the attempt it belongs to. */
function buildSignIn(facts: SignInFlowFacts, attempt: number, inline: boolean): SignInFlowState {
  return { ...facts, progress: deriveSignInProgress(facts), attempt, inline };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a request that never produced a response. `OxyServices.handleError`
 * normalizes transport failures to `NETWORK_ERROR` / `TIMEOUT` with status `0`.
 */
function requestFailureReason(error: unknown): SignInFailureReason {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'NETWORK_ERROR' || code === 'TIMEOUT' || extractErrorStatus(error) === 0) {
    return 'network';
  }
  return 'unknown';
}

type SnapshotListener = (snapshot: AccountDialogSnapshot) => void;

export class AccountDialogController {
  private readonly oxyServices: OxyServices;
  private readonly sessionClient: SessionClient;
  private readonly clientId: string | null;
  private readonly commitSession?: (session: SessionLoginResponse) => Promise<void>;
  private readonly onSignedIn?: (user: MinimalUserData) => void;
  private readonly pollIntervalMs: number;
  private readonly openUrl?: (url: string) => void;
  private readonly canOpenApp?: (url: string) => Promise<boolean>;
  private readonly socketFactory?: SocketIOFactory;
  private readonly platform: CommonsDeliveryPlatform;

  private readonly listeners = new Set<SnapshotListener>();

  // --- Internal (unprojected) state ---
  private view: AccountDialogView = 'accounts';
  private loading = false;
  private error: string | null = null;
  private activatingContextId: string | null = null;
  private removingContextId: string | null = null;
  private removingPrincipalId: string | null = null;
  /**
   * `true` while an operation run through {@link runDeviceMutation} (a host
   * sign-out) is in flight. The fourth member of the ONE device-mutation gate,
   * alongside the three flags above.
   */
  private exclusiveMutationInFlight = false;
  private signIn: SignInFlowState = buildSignIn(IDLE_SIGN_IN_FACTS, 0, false);
  private commonsAvailability: CommonsAvailability = 'unknown';

  // --- Sign-in device-flow bookkeeping ---
  /**
   * The CURRENT sign-in attempt. Every asynchronous step of a sign-in captures
   * it before awaiting and re-checks it after (`isCurrentAttempt`); cancelling,
   * starting another attempt, or destroying the controller moves it, so a late
   * response from an abandoned attempt can neither update the surface nor
   * install a session.
   */
  private signInAttempt = 0;
  /** How the current attempt was started, so a retry repeats the user's choice. */
  private signInMethod: SignInMethod = 'oxy';
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
   * single-use token concurrently. Keyed by token, so a poll still running for an
   * ABANDONED request never blocks the next request's first poll.
   */
  private pollInFlightToken: string | null = null;

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
    this.commitSession = options.commitSession;
    this.onSignedIn = options.onSignedIn;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.openUrl = options.openUrl;
    this.canOpenApp = options.canOpenApp;
    this.socketFactory = options.socketFactory;
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
      // A device change (switch / sign-out / sibling sign-in) re-reads the
      // directory inside `SessionClient` before it notifies, so the snapshot
      // this rebuilds is already the new one — publish it and reconcile the
      // auth-readiness edge. No profile fetch: the directory carries the display
      // metadata a row needs.
      this.emit();
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
    // Nothing still in flight may act on a destroyed controller.
    this.signInAttempt += 1;
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
    // Signed out. The directory is bearer-read and `SessionClient` drops the one
    // it holds when the device empties, so there is nothing to clear here — only
    // the in-flight bookkeeping, which no longer describes anything. The account
    // menu described the account that just left, so it gives way to the entry.
    this.error = null;
    this.loading = false;
    this.view = this.resolveView(this.view);
    this.emit();
  }

  // =========================================================================
  // View actions
  // =========================================================================

  /**
   * Set the dialog view directly.
   *
   * `'accounts'` is only honoured with a session. Signed out it lands on the
   * sign-in entry instead — the menu it would open holds "Switch account",
   * storage and "Sign out" for an account that does not exist.
   */
  setView(requested: AccountDialogView): void {
    const view = this.resolveView(requested);
    if (this.view === view) return;
    this.view = view;
    // A `'completed'` flow owns no timers, socket, or token — it is only
    // the terminal "Identity confirmed" the finished surface showed. Moving to
    // another view is a NEW intention, so drop it; otherwise a later `add()`
    // would open on the previous sign-in's terminal state.
    if (this.signIn.phase === 'completed') {
      this.signIn = this.stampSignIn(IDLE_SIGN_IN_FACTS);
    }
    this.emit();
  }

  /**
   * Go back one step: `signup` and `qr` return to the sign-in entry, and the
   * entry returns to the account menu when somebody is signed in.
   *
   * Returns `false` — changing nothing — when the current view is the dialog's
   * first one, so the host closes the dialog instead. Leaving an active
   * request withdraws it; otherwise its authorize code stays approvable until
   * it expires.
   */
  back(): boolean {
    const target = backViewOf(this.view, this.hasSession());
    if (target === null) return false;
    if (this.signIn.phase === 'starting' || this.signIn.phase === 'waiting') {
      this.cancelSignIn();
    }
    this.setView(target);
    return true;
  }

  /** `'accounts'` needs a session; without one the sign-in entry stands in for it. */
  private resolveView(view: AccountDialogView): AccountDialogView {
    return view === 'accounts' && !this.hasSession() ? 'signin' : view;
  }

  /**
   * Whether an account is signed in here — the precondition of the account
   * menu. The bearer, not the directory: the directory is bearer-read, and the
   * menu's content (hero, storage, sign-out) is all about the bearer's account.
   */
  private hasSession(): boolean {
    return this.isAuthenticated();
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
  // The directory
  // =========================================================================

  /**
   * Re-read `GET /session/device/directory`. Safe to call repeatedly;
   * concurrent calls are reconciled by a sequence guard so a slow earlier read
   * never overwrites a newer result.
   *
   * This is ONE request. It used to be three — the directory, plus
   * `listAccounts()` and `getUsersByIds()` to rebuild the same tree client-side
   * — and the reconstruction was not merely redundant: it enumerated the
   * CALLER's account graph, which on a device holding two people is one
   * person's answer presented as the device's.
   *
   * Resolves `false` when THIS read failed (a 401 is the signed-out edge, not a
   * failure). Never rejects.
   */
  async refresh(): Promise<boolean> {
    const seq = ++this.refreshSeq;

    // Never read the directory while signed out: at cold boot the bearer is not
    // planted yet, so the call 401s → `HttpService` clears the token and signs
    // the user out.
    if (!this.isAuthenticated()) {
      this.loading = false;
      this.error = null;
      this.emit();
      return true;
    }

    // Nothing to show yet is the only state worth a spinner; a re-read behind an
    // already-rendered directory refreshes in place.
    this.loading = this.sessionClient.getDirectory() === null;
    this.error = null;
    this.emit();

    let failure: string | null = null;
    try {
      await this.sessionClient.refreshDirectory();
    } catch (error) {
      // A 401 is the EXPECTED signed-out edge, not a failure: the bearer was
      // stale/revoked, so `HttpService` already cleared it and emitted
      // `onTokensChanged(null)`. Any OTHER error (network, 5xx, malformed) IS
      // unexpected — surface it, and keep whatever directory is already held so
      // an outage degrades rather than blanks the switcher.
      if (extractErrorStatus(error) === 401) {
        logger.debug('[AccountDialogController] directory unauthorized (signed out)', { component: 'AccountDialogController' }, error);
      } else {
        failure = errorMessage(error);
        logger.warn('[AccountDialogController] directory refresh failed', { component: 'AccountDialogController' }, error);
      }
    }
    // Superseded by a newer refresh: that read owns `error` and `loading`, so an
    // older failure must not overwrite its outcome.
    if (seq !== this.refreshSeq) return failure === null;

    this.error = failure;
    this.loading = false;
    this.emit();
    return failure === null;
  }

  // =========================================================================
  // Activation and the two removals (ADR 0002)
  // =========================================================================

  /**
   * Activate one `principal acting as account` context — the ADR 0002 switch,
   * and the one that can express what an account id cannot: WHICH person's
   * route to a shared organization to become.
   *
   * There is no on-device/graph fork. The directory has a row for a context the
   * principal may act as but has never entered, and `POST /session/device/
   * activate` reuses or mints the delegated session server-side, so one call
   * covers both cases.
   *
   * A context id is not stable across a removal, so a stale one is an ordinary
   * outcome rather than a bug: the server answers 404 or 403, heals the row, and
   * the refresh below re-reads a directory that no longer offers it.
   *
   * Resolves `true` once the SWITCH happened — even if the directory re-read
   * after it fails (that failure lands on `error`, but the subject did change).
   * Resolves `false` when the switch failed, or was refused because another
   * device mutation is in flight ({@link isDeviceMutationInFlight}).
   */
  async activateContext(contextId: string): Promise<boolean> {
    return this.mutateDevice(
      () => {
        this.activatingContextId = contextId;
      },
      () => {
        this.activatingContextId = null;
      },
      () => this.sessionClient.activateContext(contextId),
    );
  }

  /**
   * A device account row was chosen — the one entry point for "use this
   * account", whether or not anybody is signed in here.
   *
   * Signed in, it is a switch: the active row is already the answer
   * (`'current'`), any other row is {@link activateContext}.
   *
   * Signed out, it is NOT a switch. The row is on the list because the DEVICE
   * still holds that identity (Commons' shared identity, or a sibling app's
   * session), not because this app does, so there is no bearer to activate a
   * context with — and the active-row short-circuit used to read that stale
   * "active" as "already signed in" and close the sheet on a signed-out app
   * (OxyHQ/oxy#1375 item 20). Choosing the row is "Continue as @handle": the
   * same {@link signInWithOxy} path as the "Continue with Oxy" button, which
   * mints silently from the shared identity and otherwise falls back to the
   * request. When that silent mint lands on a different pair from the one
   * chosen (a device holding more than one person, or an organization row), the
   * chosen row is then activated under the new bearer, so the press ends where
   * it pointed.
   */
  async chooseContext(contextId: string): Promise<ContextChoiceOutcome> {
    if (this.isDeviceMutationInFlight()) return 'busy';
    if (this.hasSession()) {
      if (contextId === this.snapshot.activeContext?.contextId) return 'current';
      return (await this.activateContext(contextId)) ? 'switched' : 'failed';
    }
    await this.signInWithOxy();
    // Only a sign-in that finished here (the silent shared-identity mint) can be
    // steered to the chosen row; a request still waiting on approval belongs to
    // whoever approves it.
    if (this.signIn.phase !== 'completed' || !this.hasSession()) return 'signing-in';
    const directory = this.sessionClient.getDirectory();
    const offered = directory?.principals.some((principal) =>
      principal.contexts.some((context) => context.id === contextId),
    );
    if (!offered || resolveActiveContext(directory)?.contextId === contextId) return 'signing-in';
    return (await this.activateContext(contextId)) ? 'switched' : 'signing-in';
  }

  /**
   * Remove ONE `principal → account` pair, and only that pair.
   *
   * Not the account across the device: the same organization reached through a
   * second person is a different session with a different audit actor, and it
   * stays. Routing this through `signOut({accountId})` would revoke that second
   * person's access as a side effect of one person tidying their own list.
   *
   * The removed pair is not gone for good while the membership lives — the
   * server offers it again on the next read, under a NEW id and at an unchanged
   * revision — so nothing may hold a context id across this call.
   */
  async signOutContext(contextId: string): Promise<boolean> {
    return this.mutateDevice(
      () => {
        this.removingContextId = contextId;
      },
      () => {
        this.removingContextId = null;
      },
      () => this.sessionClient.signOutContext(contextId),
    );
  }

  /**
   * Remove ONE PERSON and every context they reach — and nobody else's,
   * including when another principal independently operates the same account.
   *
   * A separate call from {@link signOutContext} because it is a separate
   * question, not a loop over the first one: the server removes the principal
   * and elects a replacement active context in one transition.
   */
  async signOutPrincipal(principalId: string): Promise<boolean> {
    return this.mutateDevice(
      () => {
        this.removingPrincipalId = principalId;
      },
      () => {
        this.removingPrincipalId = null;
      },
      () => this.sessionClient.signOutPrincipal(principalId),
    );
  }

  /**
   * Whether ANY operation that changes who is on this device, or which of them
   * is active, is in flight: an activation, either removal, or a host operation
   * run through {@link runDeviceMutation}.
   *
   * They share ONE gate because they mutate the same device set: a removal that
   * elects a replacement active context racing a switch could leave either one
   * active. A refused call is refused, never queued — a press that could not run
   * must not fire later, after the user has moved on.
   */
  isDeviceMutationInFlight(): boolean {
    return (
      this.activatingContextId !== null ||
      this.removingContextId !== null ||
      this.removingPrincipalId !== null ||
      this.exclusiveMutationInFlight
    );
  }

  /**
   * Run a device mutation the controller does not own (the host's sign-out)
   * under the same gate as {@link activateContext} and the removals.
   *
   * Resolves `{ ran: false }` without calling `operation` when another mutation
   * is in flight; otherwise `{ ran: true, value }`. A rejection from `operation`
   * propagates, after the gate is released.
   */
  async runDeviceMutation<T>(
    operation: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.isDeviceMutationInFlight()) return { ran: false };
    this.exclusiveMutationInFlight = true;
    try {
      return { ran: true, value: await operation() };
    } finally {
      this.exclusiveMutationInFlight = false;
    }
  }

  /**
   * The shared body of the three controller-owned device mutations: take the
   * gate, run the mutation, then re-read the directory.
   *
   * The mutation's outcome and the re-read's are kept apart. Once `operation`
   * has resolved the device HAS changed, so this resolves `true` even when the
   * re-read fails — that failure is the directory's (`error`), and reporting it
   * as a failed switch would invite the user to repeat something that happened.
   */
  private async mutateDevice(
    mark: () => void,
    clear: () => void,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    if (this.isDeviceMutationInFlight()) return false;
    mark();
    this.error = null;
    this.emit();
    try {
      try {
        await operation();
      } catch (error) {
        this.error = errorMessage(error);
        return false;
      }
      await this.refresh();
      return true;
    } finally {
      clear();
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
   * QR handoff — as the SAME attempt, so cancelling during either half stops both.
   */
  async signInWithOxy(): Promise<void> {
    const attempt = this.beginSignInAttempt('oxy');
    this.setView('qr');
    this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'starting' });
    try {
      // Minted WITHOUT planting the bearer: `completeSignIn` installs it only if
      // this attempt is still the current one when the mint returns.
      const session = await this.oxyServices.signInWithSharedIdentity({ plantTokens: false });
      if (!this.isCurrentAttempt(attempt)) return;
      if (session) {
        await this.completeSignIn(attempt, session, session.user);
        return;
      }
    } catch (error) {
      if (!this.isCurrentAttempt(attempt)) return;
      // Shared-key mint failed — log and fall through to the QR handoff rather
      // than dead-ending the sign-in.
      logger.warn('[AccountDialogController] signInWithSharedIdentity failed', { component: 'AccountDialogController' }, error);
    }
    await this.startDeviceFlowSession(attempt, { deliver: true });
  }

  /**
   * Begin (or restart) the cross-device QR handoff: create a device-flow
   * session, surface its `authorizeCode` + `qrPayload`, and poll for approval.
   * On approval the secret token is exchanged (`claimSessionByToken`) and the
   * session committed. Requires `clientId`.
   */
  async showQr(): Promise<void> {
    const attempt = this.beginSignInAttempt('qr');
    this.setView('qr');
    await this.startDeviceFlowSession(attempt, { deliver: true });
  }

  /**
   * The sign-in entry's EMBEDDED QR: a request whose only route is the QR,
   * started without leaving the current view.
   *
   * Unlike {@link showQr} it runs no delivery selection. The surface starts it
   * by itself, on mount, so it must not push to the person's phone or open
   * Commons — nobody asked for either. Any other sign-in the person then
   * chooses supersedes it (and withdraws its request) like any new attempt.
   */
  async startInlineQr(): Promise<void> {
    const attempt = this.beginSignInAttempt('inline-qr');
    await this.startDeviceFlowSession(attempt, { deliver: false });
  }

  /**
   * Start a NEW attempt the same way the last one was started — "Try again"
   * repeats the user's choice rather than silently switching method: a failed
   * "Sign in with Oxy" retries that; an explicit QR request shows the QR.
   */
  retrySignIn(): Promise<void> {
    switch (this.signInMethod) {
      case 'qr':
        return this.showQr();
      case 'inline-qr':
        return this.startInlineQr();
      default:
        return this.signInWithOxy();
    }
  }

  /**
   * End whatever attempt is running (withdrawing its request) and begin a new
   * one. Returns the new attempt's identity for the caller to re-check after
   * every `await`.
   */
  private beginSignInAttempt(method: SignInMethod): number {
    this.cancelSignIn();
    this.signInMethod = method;
    return this.signInAttempt;
  }

  /** Whether `attempt` is still the one the surface is waiting on. */
  private isCurrentAttempt(attempt: number): boolean {
    return attempt === this.signInAttempt;
  }

  /**
   * Shared device-flow session creation for {@link signInWithOxy},
   * {@link showQr} and {@link startInlineQr} — the same `startCommonsSignIn` →
   * poll/socket wiring every time. Returns the
   * handle on success (already reflected in `signIn`), or `null` when the
   * attempt failed (already set as `signIn.failure`) or was abandoned while the
   * request was being created.
   *
   * @param attempt - The attempt this request belongs to. A request that comes
   *   back for an abandoned attempt is withdrawn server-side and never wired up:
   *   closing the dialog on a slow connection must not leave an approvable
   *   request, a socket, and a poll behind it.
   * @param opts.deliver - Whether to run automatic Commons delivery selection
   *   ({@link resolveDeliveryRoute}). `true` for the normal one-primary-action
   *   entry; `false` for the embedded QR, which the screen starts by itself,
   *   where the request's Commons route is simply the QR.
   */
  private async startDeviceFlowSession(
    attempt: number,
    opts: { deliver: boolean },
  ): Promise<CommonsSignInHandle | null> {
    if (!this.isCurrentAttempt(attempt)) return null;
    if (!this.clientId) {
      this.failSignIn('not-configured', 'This app is not configured for sign-in (missing clientId).');
      return null;
    }
    this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'starting' });
    let handle: CommonsSignInHandle;
    try {
      handle = await this.oxyServices.startCommonsSignIn({ clientId: this.clientId });
    } catch (error) {
      if (!this.isCurrentAttempt(attempt)) return null;
      this.failSignIn(requestFailureReason(error), errorMessage(error));
      return null;
    }
    if (!this.isCurrentAttempt(attempt)) {
      // Created after the user walked away. The cancel could not withdraw it (it
      // had no code yet), so withdraw it now — best effort, like every withdrawal.
      void this.withdrawRequest(handle.authorizeCode);
      return null;
    }
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
    void this.openAuthSessionSocket(handle.sessionToken);
    this.scheduleNextPoll(handle.sessionToken);
    if (opts.deliver) {
      // Non-blocking on purpose: the QR/authorizeCode are already renderable,
      // while the route (a local probe plus at most one delivery round-trip)
      // resolves behind it.
      void this.resolveDeliveryRoute(handle);
    }
    return handle;
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
   * Tear down the active sign-in device flow (timers + socket + token),
   * WITHDRAW the request server-side, and reset to idle.
   *
   * Cancellation has to converge in both directions: the surface closing must
   * cancel the request, not just stop listening to it. Without the withdrawal a
   * dismissed QR would stay approvable until it expired, so a later scan of a
   * stale code could authorize a session nobody is waiting for.
   *
   * It also ENDS the attempt: anything of it still awaiting a response (the
   * request being created, a shared-identity mint, a claim) finds itself
   * superseded when that response arrives, and neither touches the surface nor
   * installs a session. The withdrawal itself is best effort — cancelling
   * locally is not proof the server received it (see {@link withdrawRequest}).
   */
  cancelSignIn(): void {
    this.signInAttempt += 1;
    // Capture before the teardown clears it, and only for a request that can
    // still be approved — a completed/failed flow has nothing to withdraw.
    const pendingCode =
      this.signIn.phase === 'starting' || this.signIn.phase === 'waiting'
        ? this.signIn.authorizeCode
        : null;
    this.clearPollTimer();
    this.closeAuthSessionSocket();
    this.signInToken = null;
    if (this.signIn.phase !== 'idle') {
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
    if (this.signInToken !== sessionToken || this.pollInFlightToken === sessionToken) return;
    const attempt = this.signInAttempt;
    this.pollInFlightToken = sessionToken;
    try {
      const expiresAt = this.signIn.expiresAt;
      if (typeof expiresAt === 'number' && Date.now() > expiresAt) {
        this.failSignIn('expired', 'Session expired. Please try again.');
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
          this.failSignIn('unsupported-flow', 'This sign-in flow cannot be completed here. Use the app\'s OAuth sign-in instead.');
          return;
        }
        if (status.authorized && status.sessionId) {
          this.clearPollTimer();
          await this.claimAndComplete(attempt, status.sessionId, sessionToken);
          return;
        }
        if (status.status === 'cancelled') {
          this.failSignIn('denied', 'Authorization was denied.');
          return;
        }
        if (status.status === 'expired') {
          this.failSignIn('expired', 'Session expired. Please try again.');
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
      if (this.pollInFlightToken === sessionToken) this.pollInFlightToken = null;
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

  private async claimAndComplete(attempt: number, sessionId: string, sessionToken: string): Promise<void> {
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
      // Claimed WITHOUT planting the bearer — `completeSignIn` installs it only
      // if the user is still waiting for this attempt when the claim returns.
      claimed = await this.oxyServices.claimSessionByToken(sessionToken, { plantTokens: false });
    } catch (error) {
      if (!this.isCurrentAttempt(attempt)) return;
      this.failSignIn('claim-failed', errorMessage(error));
      return;
    }
    if (!this.isCurrentAttempt(attempt)) return;
    if (!claimed?.accessToken || !claimed.user) {
      this.failSignIn('claim-failed', 'Authorization succeeded but the session could not be claimed. Please try again.');
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
        attempt,
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
      if (this.isCurrentAttempt(attempt)) this.failSignIn('unknown', errorMessage(error));
    }
  }

  /**
   * Install an authorized session, notify, and return to the account list.
   * Shared by the shared-key and QR paths so they cannot drift.
   *
   * THE install point, and so the last place an abandoned attempt is stopped:
   * the bearer is planted and the session committed only while `attempt` is
   * still current. A commit that fails restores the bearer the client had
   * before, so a half-installed session never leaves requests going out as an
   * account the device does not hold.
   *
   * A failed commit REJECTS (after that restore), so each caller keeps its own
   * policy: the QR path fails the attempt, the shared-identity path falls
   * through to the QR handoff.
   *
   * Once the commit has resolved the session IS this device's, whether or not
   * the user moved on while it ran. It is reported (`onSignedIn`, re-read) either
   * way; only the surface bookkeeping is skipped for a superseded attempt, so a
   * newer attempt's state is never overwritten.
   *
   * Residual: an attempt abandoned after the server minted its session (a claim
   * or shared-identity mint that was already in flight) leaves that server
   * session un-installed on this device — it is never planted or committed here,
   * but it is not revoked either.
   */
  private async completeSignIn(
    attempt: number,
    session: SessionLoginResponse,
    user: MinimalUserData,
  ): Promise<void> {
    if (!this.isCurrentAttempt(attempt)) return;
    const previousToken = this.oxyServices.getAccessToken();
    try {
      if (session.accessToken) this.oxyServices.setTokens(session.accessToken);
      await this.commitAuthorizedSession(session, user);
    } catch (error) {
      if (session.accessToken && this.oxyServices.getAccessToken() === session.accessToken) {
        if (previousToken) this.oxyServices.setTokens(previousToken);
        else this.oxyServices.clearTokens();
      }
      throw error;
    }
    if (this.isCurrentAttempt(attempt)) {
      this.signInToken = null;
      this.clearPollTimer();
      this.closeAuthSessionSocket();
        // Terminal SUCCESS, not idle: the surface gets one honest frame to show
      // "Identity confirmed" before it closes. Cleared on the next view change.
      this.signIn = this.stampSignIn(COMPLETED_SIGN_IN_FACTS);
      this.view = 'accounts';
      this.emit();
    }
    this.onSignedIn?.(user);
    await this.refresh();
  }

  /**
   * Register a token-planted session into the device set. Prefers the
   * consumer's commit funnel (durable persist + hydration); falls back to
   * `SessionClient.registerAndActivate` (registration + activation only).
   */
  private async commitAuthorizedSession(
    session: SessionLoginResponse,
    user: MinimalUserData,
  ): Promise<void> {
    if (this.commitSession) {
      await this.commitSession(session);
    } else {
      await this.sessionClient.registerAndActivate(user.id);
    }
  }

  /**
   * End the CURRENT attempt as failed. The attempt keeps its identity (the
   * failure belongs to it); only a new attempt or a cancel moves it on.
   */
  private failSignIn(failure: SignInFailureReason, message: string): void {
    this.clearPollTimer();
    this.closeAuthSessionSocket();
    this.signInToken = null;
    this.setSignIn({ ...IDLE_SIGN_IN_FACTS, phase: 'error', error: message, failure });
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
   * No-op (poll-only) when the optional socket transport is unavailable. The
   * namespace needs no auth.
   */
  private async openAuthSessionSocket(sessionToken: string): Promise<void> {
    this.closeAuthSessionSocket();
    const socketFactory = this.socketFactory ?? (await getSocketIO());
    if (!socketFactory || this.signInToken !== sessionToken) return;
    let socket: MinimalSocket;
    try {
      socket = socketFactory(`${this.oxyServices.getBaseURL()}${AUTH_SESSION_NAMESPACE}`, {
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
    this.signIn = this.stampSignIn(facts);
    this.emit();
  }

  /** `facts` as the current attempt's state. */
  private stampSignIn(facts: SignInFlowFacts): SignInFlowState {
    return buildSignIn(facts, this.signInAttempt, this.signInMethod === 'inline-qr');
  }

  /** Update a subset of the device-flow facts, re-deriving `progress`. */
  private patchSignIn(patch: Partial<SignInFlowFacts>): void {
    const {
      phase,
      authorizeCode,
      qrPayload,
      expiresAt,
      error,
      failure,
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
      failure,
      route,
      routeFailed,
      pushSentAt,
      openedAt,
      ...patch,
    });
  }

  private computeSnapshot(): AccountDialogSnapshot {
    const directory = this.sessionClient.getDirectory();
    const hasSession = this.hasSession();
    // Resolved here as well as in `setView`: the controller is constructed on
    // `'accounts'` before anyone knows whether a bearer exists.
    const view = this.resolveView(this.view);
    return {
      view,
      backView: backViewOf(view, hasSession),
      hasSession,
      directory,
      activeContext: resolveActiveContext(directory),
      loading: this.loading,
      error: this.error,
      activatingContextId: this.activatingContextId,
      removingContextId: this.removingContextId,
      removingPrincipalId: this.removingPrincipalId,
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

/**
 * The view one step back from `view`, or `null` when `view` is the dialog's
 * first view.
 *
 * The sign-in entry is `'add'` ("add another account") when somebody is signed
 * in and `'signin'` when nobody is; `signup` and `qr` are reached FROM that
 * entry, so they return to it. The entry itself returns to the account menu —
 * which exists only with a session. This used to be a host-side
 * "back = accounts" that assumed a signed-in origin, so a signed-out Back from
 * "Create your account" opened a menu holding "Sign out" for nobody.
 */
export function backViewOf(view: AccountDialogView, hasSession: boolean): AccountDialogView | null {
  switch (view) {
    case 'signup':
    case 'qr':
      return hasSession ? 'add' : 'signin';
    case 'add':
      return hasSession ? 'accounts' : null;
    case 'signin':
    case 'accounts':
      return null;
  }
}

/** Factory mirroring `createSessionClient`, for ergonomic wiring by consumers. */
export function createAccountDialogController(
  options: AccountDialogControllerOptions,
): AccountDialogController {
  return new AccountDialogController(options);
}
