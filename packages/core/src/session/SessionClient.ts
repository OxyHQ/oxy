import {
  deviceActivateResponseSchema,
  deviceDirectorySchema,
  deviceSessionStateSchema,
  deviceSessionSyncSchema,
  safeParseContract,
  SESSION_ACCOUNTS_CHANGED_EVENT,
  sessionAccountsChangedEventSchema,
  type DeviceDirectory,
  type DeviceSessionState,
} from '@oxyhq/contracts';
import { logger } from '../logger';
import { computeIdentityTag } from '../utils/cacheKey';
import { resolveActiveContext, type DeviceContext } from './deviceDirectory';
import { getSocketIO } from './socketLoader';
import type { MinimalSocket, SocketIOFactory } from './socketLoader';

export interface TokenTransport {
  /** Ensure this app holds a per-domain access token for state.activeAccountId (mint via the persisted refresh family / shared keychain). Best-effort. */
  ensureActiveToken(state: DeviceSessionState): Promise<void>;
}

/**
 * Where an applied device state came from, so consumers can decide how
 * AUTHORITATIVE a zero-account ("signed out") verdict is:
 *  - `request` — the response to a direct REST call this client made
 *    (`bootstrap` / `switch` / `signOut` / `add`). A stable, server-authoritative
 *    verdict: an empty state here reflects a real sign-out or revocation, so the
 *    durable device credential MAY be erased.
 *  - `push` — an out-of-band Socket.IO `session_state` broadcast. Potentially
 *    transient (a reconnect race / another device's mutation), so an empty state
 *    here must NOT erase THIS origin's durable device credential — only clear the
 *    local UI session. A dead credential re-mints to `no_active_session` and
 *    resolves signed-out cleanly on the next boot; a wrongly-erased one cannot be
 *    recovered without a fresh sign-in.
 */
export type SessionStateOrigin = 'request' | 'push';

export interface DeviceCredential {
  deviceId: string;
  deviceSecret: string;
}

export interface SessionClientHost {
  makeRequest<T>(method: 'GET' | 'POST', url: string, data?: unknown, options?: { cache?: boolean }): Promise<T>;
  getBaseURL(): string;
  getAccessToken(): string | null;
  /** Zero-cookie device credential for socket handshake when no bearer is planted yet. */
  getDeviceCredential(): DeviceCredential | null;
  onTokensChanged(listener: (token: string | null) => void): () => void;
  setTokens(accessToken: string): void;
  getCurrentAccountId(): string | null;
}

export interface SessionClientOptions {
  transport?: TokenTransport;
  /**
   * Invoked when an APPLIED state has zero accounts — i.e. a device
   * signout-all removed the last account from this device set. Providers use
   * this to clear local session state and, for a `request`-origin verdict, the
   * persisted {@link AuthStateStore} so a reload does not try to restore a
   * session that no longer exists on the device.
   *
   * The {@link SessionStateOrigin} is passed so the consumer can gate the
   * DESTRUCTIVE credential wipe: a `push`-origin empty state (a socket broadcast,
   * possibly a transient reconnect artifact) must NOT erase the durable device
   * credential — only a `request`-origin verdict (a direct REST sign-out /
   * revocation) is authoritative enough for that.
   *
   * Only fires when a state is actually applied (revision advanced), never on
   * a stale/rejected push. Exceptions thrown by the callback are isolated.
   */
  onUnauthenticated?: (origin: SessionStateOrigin) => void;
  /**
   * Statically-injected `socket.io-client` factory (its `io` export).
   * `@oxyhq/services` lists `socket.io-client` as a real dependency and
   * passes `io` in directly, so realtime session sync never
   * depends on a runtime dynamic `import('socket.io-client')` of a bare
   * specifier — which is bundler-fragile in Metro/Expo-web and Vite when
   * `@oxyhq/core` is consumed as its published dist (the import resolves to
   * nothing → `connectSocket` warns and falls back to REST-only). When this is
   * provided, `connectSocket` uses it and never touches the lazy loader; when
   * absent it falls back to `getSocketIO()`.
   */
  socketFactory?: SocketIOFactory;
  /**
   * The PINNED account id for an IDENTITY-BOUND client (the identity vault),
   * or `null` for every ordinary account-mode client. Read as a function because
   * the pin is resolved asynchronously at boot and can move when the identity
   * session is re-established.
   *
   * While pinned this client tracks device state TRUTHFULLY — other apps'
   * accounts and the device's real `activeAccountId` stay visible in `getState()`
   * — but it NEVER re-binds its bearer to that active account: no `activeToken`
   * is planted for a non-pinned account (from a sync response or a pushed
   * `session_state`), the `TokenTransport` (whose entire job is converging on
   * `activeAccountId`) is bypassed, and a push that switches the device does not
   * trigger a token re-fetch. The pinned token's lifecycle belongs solely to the
   * cold boot / re-mint lane, which mints it with an explicit `accountId`.
   */
  getPinnedAccountId?: () => string | null;
}

type StateListener = (state: DeviceSessionState | null) => void;
type DirectoryListener = (directory: DeviceDirectory | null) => void;

/**
 * Same-origin `BroadcastChannel` name for instant, network-free session-state
 * propagation across tabs of the SAME origin (e.g. two `accounts.oxy.so` tabs):
 * when one authenticated tab commits an account switch / sign-out, siblings
 * re-sync their device state without waiting on the socket. Cross-origin
 * same-apex propagation rides the authenticated device socket; cross-APEX
 * (mention.earth) relies on a reload — the documented limitation.
 */
const SESSION_BROADCAST_CHANNEL = 'oxy.session';

/** A minimal, feature-detected `BroadcastChannel` surface (absent on native RN). */
interface SessionBroadcastChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export class SessionClient {
  private state: DeviceSessionState | null = null;
  /**
   * The device DIRECTORY (ADR 0002) — principals, the contexts each may act as,
   * and which context is active. Held BESIDE `state` rather than replacing it:
   * `state` is the flat compatibility projection every app renders until Phase 7
   * moves it, and the two describe the same device at the same `revision`.
   *
   * `null` until something asks for it. A client that never calls
   * {@link refreshDirectory} has no consumer for a directory and never pays for
   * the round trip — which is also what keeps the whole account lane's request
   * count unchanged.
   */
  private directory: DeviceDirectory | null = null;
  private readonly listeners = new Set<StateListener>();
  private readonly directoryListeners = new Set<DirectoryListener>();
  protected socket: MinimalSocket | null = null;
  private tokenUnsub: (() => void) | null = null;
  private started = false;
  /** Same-origin cross-tab state-propagation channel; null on platforms without BroadcastChannel. */
  private channel: SessionBroadcastChannel | null = null;
  /** App-facing subscriptions to named server-pushed socket events. */
  private readonly serverEvents = new Map<string, Set<(payload: unknown) => void>>();
  /** Event names already bound on the CURRENT socket instance. */
  private readonly boundServerEvents = new Set<string>();

  constructor(
    protected readonly host: SessionClientHost,
    protected readonly options: SessionClientOptions = {},
  ) {}

  getState(): DeviceSessionState | null {
    return this.state;
  }

  /**
   * The device directory, or `null` when this client has never read one.
   * Populated by {@link refreshDirectory} / {@link activateContext} and kept
   * fresh from there on.
   */
  getDirectory(): DeviceDirectory | null {
    return this.directory;
  }

  /**
   * The active `principal acting as account` pair, with the actor and the
   * subject kept apart. `null` when no directory has been read, or when the
   * device genuinely has no active context.
   *
   * This is the answer `getState()` cannot give: `activeAccountId` names the
   * subject and says nothing about whose authentication is behind it.
   */
  getActiveContext(): DeviceContext | null {
    return resolveActiveContext(this.directory);
  }

  /**
   * The account this client's bearer is pinned to, or `null` when it follows the
   * device's active account (the default). Resolvers are expected to be a plain
   * synchronous read of already-resolved state (see
   * {@link SessionClientOptions.getPinnedAccountId}).
   */
  private pinnedAccountId(): string | null {
    return this.options.getPinnedAccountId?.() ?? null;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to the directory half. Fires from the SAME {@link notify} as
   * {@link subscribe}, so the flat state and the directory are never published
   * at two different points of the ordering sequence — a directory subscriber
   * and a state subscriber woken by one transition always see the same device
   * revision under the same bearer.
   */
  subscribeDirectory(listener: DirectoryListener): () => void {
    this.directoryListeners.add(listener);
    return () => {
      this.directoryListeners.delete(listener);
    };
  }

  /**
   * Subscribe to a named server-pushed Socket.IO event (e.g. `civic:attested`).
   * Listeners survive reconnects and socket re-creation; the returned function
   * unsubscribes. Payloads are delivered as-is — callers validate shape.
   */
  onServerEvent(event: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.serverEvents.get(event);
    if (!listeners) {
      listeners = new Set();
      this.serverEvents.set(event, listeners);
    }
    listeners.add(listener);
    this.bindServerEvent(event);
    return () => {
      listeners.delete(listener);
    };
  }

  private bindServerEvent(event: string): void {
    if (!this.socket || this.boundServerEvents.has(event)) return;
    this.boundServerEvents.add(event);
    this.socket.on(event, (payload: unknown) => {
      const listeners = this.serverEvents.get(event);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          listener(payload);
        } catch (error) {
          logger.warn('[SessionClient] server-event listener threw', { component: 'SessionClient' }, error);
        }
      }
    });
  }

  protected notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        logger.error('[SessionClient] subscriber threw', error);
      }
    }
    for (const listener of this.directoryListeners) {
      try {
        listener(this.directory);
      } catch (error) {
        logger.error('[SessionClient] directory subscriber threw', error);
      }
    }
  }

  /**
   * Validate + last-writer-wins by revision. Returns true if applied.
   *
   * `activeToken` (sync path only) is the server-issued access token for
   * `raw.activeAccountId`. When present and the state is applied, it is planted
   * BEFORE any subscriber is notified so the bearer already belongs to the new
   * active account — the local switch/bootstrap path then needs no redundant
   * device-secret mint. Push-origin applies carry no token and rely on the
   * mint-before-notify gate below.
   *
   * ORDERING INVARIANT: a subscriber must NEVER observe a newly-active account
   * while the planted bearer still identifies the PREVIOUS one — otherwise a
   * `useCurrentUser`-style refetch fires under the wrong account's token (the
   * account-switch 404 race). So when a transport is available and the planted
   * bearer does not already belong to `next.activeAccountId`, minting is awaited
   * BEFORE `notify()`. This covers EVERY notify source (a switch push, a
   * cross-device push, a cold mint), not just the initial "no bearer yet" case.
   */
  protected applyState(raw: unknown, origin: SessionStateOrigin = 'push', activeToken?: string): boolean {
    const next = safeParseContract(deviceSessionStateSchema, raw);
    if (!next) {
      logger.warn('[SessionClient] discarded invalid session state');
      return false;
    }
    // The revision is monotone ONLY within a single deviceId. When the incoming
    // state belongs to a DIFFERENT device than the currently-applied one, reset
    // the baseline and accept it regardless of revision: a freshly-converged
    // device (low revision) must not lose last-writer-wins to a stale, higher-
    // revision state from a retired device. Only when the deviceIds MATCH is the
    // `revision <= current` guard a valid staleness check.
    if (
      this.state &&
      next.deviceId === this.state.deviceId &&
      next.revision <= this.state.revision
    ) {
      return false;
    }
    const previousState = this.state;
    this.state = next;
    const pinnedAccountId = this.pinnedAccountId();
    // Plant the sync-supplied active token (it is for `next.activeAccountId`)
    // now — before the notify below — so the bearer matches the new active
    // account when subscribers observe it. Guarded on difference to avoid a
    // redundant token-change notification on an unchanged token (bootstrap
    // restate). An identity-bound client only accepts it when the active account
    // IS its pinned account — otherwise the token belongs to somebody else's
    // switch and must never displace the pinned bearer.
    if (
      activeToken &&
      next.activeAccountId !== null &&
      (pinnedAccountId === null || next.activeAccountId === pinnedAccountId) &&
      activeToken !== this.host.getAccessToken()
    ) {
      this.host.setTokens(activeToken);
    }
    // The transport's entire job is converging the bearer on `activeAccountId`,
    // which is precisely what an identity-bound client must not do: its token is
    // minted for the pinned account by the cold boot / re-mint lane. Bypass it
    // while pinned (also removing the mint-before-notify gate, which exists only
    // to keep the bearer and the ACTIVE account in step).
    const transport = pinnedAccountId === null ? this.options.transport : null;
    const activeAccountId = next.activeAccountId;
    // Mint before notifying when the bearer does not already belong to the new
    // active account: no bearer at all, an opaque bearer, OR a bearer for a
    // DIFFERENT account. `computeIdentityTag` yields the token's `userId`/`id`
    // for a real JWT (comparable to the account id) and a non-account sentinel
    // otherwise, so a mismatch always resolves to "mint".
    const needsMintBeforeNotify =
      transport != null &&
      next.accounts.length > 0 &&
      (activeAccountId === null || computeIdentityTag(this.host.getAccessToken()) !== activeAccountId);

    const publish = (): void => {
      this.notify();
      if (next.accounts.length === 0 && this.options.onUnauthenticated) {
        try {
          this.options.onUnauthenticated(origin);
        } catch (error) {
          logger.error('[SessionClient] onUnauthenticated threw', error);
        }
      }
    };

    // The directory half of the same ordering invariant: when this client holds
    // a directory and the flat state has just moved past it, re-read the
    // directory BEFORE anyone is notified — otherwise a directory-rendering
    // consumer observes the PREVIOUS subject under the new subject's bearer,
    // which is the account-switch race mirrored. `settleDirectory` returns null
    // (and this stays synchronous) for every client that never read a
    // directory, i.e. the whole account lane.
    const finishApply = (): void => {
      const settling = this.settleDirectory(next);
      if (settling === null) {
        publish();
        return;
      }
      void settling.then(publish);
    };

    if (needsMintBeforeNotify) {
      void transport.ensureActiveToken(next).then(finishApply).catch((error) => {
        logger.warn('[SessionClient] ensureActiveToken failed — reverting session state', { component: 'SessionClient' }, error);
        // Do NOT notify under a mismatched bearer. Revert to the last applied
        // state so subscribers keep observing the account whose token is planted.
        this.state = previousState ?? null;
      });
    } else {
      if (transport) {
        void transport.ensureActiveToken(next).catch((error) => {
          logger.warn('[SessionClient] ensureActiveToken failed', { component: 'SessionClient' }, error);
        });
      }
      finishApply();
    }
    return true;
  }

  /**
   * Validate `{ state, activeToken }`, apply the state, and plant the active token host-side.
   * Token-planting is decoupled from whether `applyState` advanced the revision: a socket push
   * followed by this same `GET /state` fetch returns the SAME revision (applyState no-ops), but
   * the token still needs to be planted. The account-match guard rejects a stale response for an
   * account that is no longer active.
   */
  private applySync(raw: unknown): void {
    const sync = safeParseContract(deviceSessionSyncSchema, raw);
    if (!sync) {
      const parsed = deviceSessionSyncSchema.safeParse(raw);
      // Log field-level type diagnostics ONLY — never values. The payload carries tokens and
      // session ids; issue.path/code and the invalid_type expected/received TYPE names are safe,
      // but zod messages can embed offending values for other codes, so they are omitted.
      const issues = parsed.success
        ? []
        : parsed.error.issues.map((issue) =>
            issue.code === 'invalid_type'
              ? { path: issue.path.join('.'), code: issue.code, expected: issue.expected, received: issue.received }
              : { path: issue.path.join('.'), code: issue.code },
          );
      const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
      logger.warn('[SessionClient] discarded invalid session sync', { component: 'SessionClient', issues, keys });
      return;
    }
    // A `sync` is always the response to a direct REST call this client made
    // (bootstrap / switch / signOut / add) → a `request`-origin, authoritative
    // verdict. Hand the active token to `applyState`: in the applied path it is
    // planted BEFORE notify (bearer matches the new active account when
    // subscribers observe it, and no redundant device-secret mint is triggered).
    const applied = this.applyState(sync.state, 'request', sync.activeToken?.accessToken);
    // Equal-revision restate (this revision was already applied by a preceding
    // socket push): `applyState` no-ops without planting, but the token still
    // needs planting. Guard on the sync's active account STILL being the current
    // active account so a stale response cannot adopt a token for an account a
    // newer state already switched away from — and, when pinned, on that account
    // being the PINNED one (same rule as the applied path in `applyState`).
    const pinnedAccountId = this.pinnedAccountId();
    if (
      !applied &&
      sync.activeToken &&
      this.state &&
      sync.state.activeAccountId !== null &&
      sync.state.activeAccountId === this.state.activeAccountId &&
      (pinnedAccountId === null || sync.state.activeAccountId === pinnedAccountId) &&
      sync.activeToken.accessToken !== this.host.getAccessToken()
    ) {
      this.host.setTokens(sync.activeToken.accessToken);
    }
  }

  /**
   * Validate + last-writer-wins by revision, exactly as {@link applyState} does
   * for the flat half — including the part that is easy to get wrong: the guard
   * is `deviceId`-SCOPED. A directory belonging to a DIFFERENT device resets the
   * baseline and is accepted at any revision, so a freshly-converged device
   * cannot lose to a retired device's higher number.
   *
   * Notifies nothing. Every caller decides where in its own ordering sequence
   * the publish belongs.
   */
  private applyDirectory(raw: unknown): boolean {
    const next = safeParseContract(deviceDirectorySchema, raw);
    if (!next) {
      logger.warn('[SessionClient] discarded invalid device directory');
      return false;
    }
    if (
      this.directory &&
      next.deviceId === this.directory.deviceId &&
      next.revision <= this.directory.revision
    ) {
      return false;
    }
    this.directory = next;
    return true;
  }

  /** `GET /session/device/directory` → {@link applyDirectory}. No notify. */
  private async fetchDirectory(): Promise<boolean> {
    const res = await this.host.makeRequest<unknown>('GET', '/session/device/directory', undefined, { cache: false });
    return this.applyDirectory(res);
  }

  /**
   * Re-read the directory when the flat state has moved past it, returning the
   * in-flight work so the caller can hold its notify until both halves describe
   * the same revision.
   *
   * `null` — meaning "nothing to settle, stay synchronous" — when this client
   * holds no directory (nobody reads one), when the directory is already at or
   * ahead of the state, or when there is no bearer to make the call with.
   * Never rejects: a failed refresh leaves the previous directory in place and
   * the next transition tries again; it must not swallow the flat state's
   * notify.
   */
  private settleDirectory(state: DeviceSessionState): Promise<void> | null {
    const held = this.directory;
    if (held === null) {
      return null;
    }
    if (held.deviceId === state.deviceId && held.revision >= state.revision) {
      return null;
    }
    if (!this.host.getAccessToken()) {
      return null;
    }
    return this.fetchDirectory().then(
      () => undefined,
      (error: unknown) => {
        logger.warn('[SessionClient] directory refresh failed', { component: 'SessionClient' }, error);
      },
    );
  }

  /**
   * The highest device revision this client currently knows for `deviceId`,
   * across BOTH halves, or `null` when it knows nothing about that device.
   *
   * Used to read the server's `changed` flag, which
   * `POST /session/device/activate` deliberately does not carry: the revision
   * already says whether the device moved, and a second field saying the same
   * thing is a second field that can disagree with the first.
   */
  private knownRevisionFor(deviceId: string): number | null {
    const fromDirectory = this.directory?.deviceId === deviceId ? this.directory.revision : null;
    const fromState = this.state?.deviceId === deviceId ? this.state.revision : null;
    if (fromDirectory === null) return fromState;
    if (fromState === null) return fromDirectory;
    return Math.max(fromDirectory, fromState);
  }

  /**
   * Plant the bearer `POST /session/device/activate` returned for the newly
   * active context, under the same guards {@link applyState} applies to a
   * sync-supplied `activeToken`: never for a null active context, never a
   * foreign account's token while pinned, and never a redundant re-plant of the
   * token already held.
   *
   * `activeToken: null` is not an error — it is an identity-pinned client, or a
   * caller whose application is not entitled to a bearer for the new context.
   */
  private plantActiveContextToken(directory: DeviceDirectory, accessToken: string | undefined): void {
    if (!accessToken) {
      return;
    }
    const subjectAccountId = resolveActiveContext(directory)?.subject.accountId ?? null;
    if (subjectAccountId === null) {
      return;
    }
    const pinnedAccountId = this.pinnedAccountId();
    if (pinnedAccountId !== null && subjectAccountId !== pinnedAccountId) {
      return;
    }
    if (accessToken === this.host.getAccessToken()) {
      return;
    }
    this.host.setTokens(accessToken);
  }

  /**
   * Bring the FLAT projection back in step after a context activation.
   *
   * The activation response answers with the directory and a bearer and
   * deliberately not with `DeviceSessionState` (ADR 0002) — but every app that
   * has not moved to the directory still renders from `getState()`, and leaving
   * it a revision behind would show the PREVIOUS subject under the new
   * subject's bearer. So it is settled BEFORE the notify, not after.
   *
   * This is also what converges the bearer when the activation returned no
   * token: `GET /session/device/state` mints one for the active account, and
   * `applyState`'s own mint-before-notify gate holds its notify until it lands.
   *
   * Non-fatal on failure — the directory is applied and (usually) the bearer is
   * planted; the socket push or the next bootstrap catches the flat half up. A
   * network blip must not turn a completed activation into a thrown error.
   */
  private async reconcileFlatState(directory: DeviceDirectory): Promise<void> {
    if (
      this.state &&
      this.state.deviceId === directory.deviceId &&
      this.state.revision >= directory.revision
    ) {
      return;
    }
    if (!this.host.getAccessToken()) {
      return;
    }
    try {
      await this.bootstrap();
    } catch (error) {
      logger.warn('[SessionClient] flat-state reconcile after activation failed', { component: 'SessionClient' }, error);
    }
  }

  async bootstrap(): Promise<void> {
    const res = await this.host.makeRequest<unknown>('GET', '/session/device/state', undefined, { cache: false });
    this.applySync(res);
  }

  /**
   * Read `GET /session/device/directory` and publish it.
   *
   * Calling this is what opts a client into the directory: from here on every
   * applied device state re-reads it (see {@link settleDirectory}), so the two
   * halves stay at one revision without the caller polling.
   */
  async refreshDirectory(): Promise<void> {
    if (await this.fetchDirectory()) {
      this.notify();
    }
  }

  /**
   * `POST /session/device/activate` — make one `principal acting as account`
   * context active (ADR 0002).
   *
   * The body is `{ contextId }` and nothing else: an `accountId` cannot name
   * what to activate on a device where two people can both reach the same
   * organization, and the server refuses a body carrying one rather than
   * guessing inside an authorization path.
   *
   * The sequence is the ADR's ordering invariant, in order — commit the bearer
   * for the new context, publish the new snapshot, notify — with the flat
   * projection reconciled in the middle so no consumer can observe the two
   * halves disagreeing.
   *
   * An IDEMPOTENT activation (the target was already active) moves no revision,
   * so it reconciles nothing and wakes no sibling tab, mirroring the server's
   * "bumps nothing and broadcasts nothing". `switchAccount` remains the
   * compatibility path for callers still keyed on account ids.
   */
  async activateContext(contextId: string): Promise<void> {
    const res = await this.host.makeRequest<unknown>('POST', '/session/device/activate', { contextId }, { cache: false });
    const activation = safeParseContract(deviceActivateResponseSchema, res);
    if (!activation) {
      logger.warn('[SessionClient] discarded invalid activation response');
      return;
    }
    const known = this.knownRevisionFor(activation.directory.deviceId);
    const moved = known === null || activation.directory.revision > known;
    this.plantActiveContextToken(activation.directory, activation.activeToken?.accessToken);
    // Applied BEFORE the reconcile, and only then: the reconcile's own
    // `GET /session/device/state` runs the full apply path, whose
    // `settleDirectory` would otherwise see a stale directory and issue a
    // second, redundant `GET /session/device/directory` for the revision we are
    // already holding in hand.
    const applied = this.applyDirectory(activation.directory);
    if (moved) {
      await this.reconcileFlatState(activation.directory);
    }
    if (applied) {
      this.notify();
    }
    if (moved) {
      this.postCommitPing();
    }
  }

  async switchAccount(accountId: string): Promise<void> {
    const res = await this.host.makeRequest<unknown>('POST', '/session/device/switch', { accountId }, { cache: false });
    this.applySync(res);
    this.postCommitPing();
  }

  async signOut(target: { accountId: string } | { all: true }): Promise<void> {
    const res = await this.host.makeRequest<unknown>('POST', '/session/device/signout', target, { cache: false });
    this.applySync(res);
    this.postCommitPing();
  }

  async addCurrentAccount(): Promise<void> {
    const res = await this.host.makeRequest<unknown>('POST', '/session/device/add', undefined, { cache: false });
    this.applySync(res);
    this.postCommitPing();
  }

  /**
   * Register the just-signed-in account into the device set AND make it the
   * ACTIVE account — the explicit user-intent activation a sign-in UI performs.
   *
   * `addCurrentAccount` alone honors the server's `activate:'if-empty'` policy
   * (a new account does NOT steal focus from an already-active one), which is
   * correct for a background/silent add but wrong right after a deliberate
   * sign-in. This adds, then switches to the target so the UI lands on the
   * account the user just authenticated.
   *
   * An identity-bound (pinned) client only ADDS: its own session is minted for
   * the pinned account explicitly, so switching the device would gratuitously
   * re-elect the active account under every OTHER app on this device — a
   * mutation a pinned client must never make.
   *
   * @param accountId - The signed-in account id (e.g. `session.user.id`). When
   *   omitted, falls back to the host's current-account ref. If neither
   *   resolves, the add still applies and no switch is performed.
   */
  async registerAndActivate(accountId?: string): Promise<void> {
    await this.addCurrentAccount();
    if (this.pinnedAccountId() !== null) return;
    const target = accountId ?? this.host.getCurrentAccountId();
    if (target && this.state?.activeAccountId !== target) {
      await this.switchAccount(target);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.tokenUnsub = this.host.onTokensChanged((token) => {
      // A rotated/fresh bearer landed — reconnect a dropped socket so its
      // handshake re-runs with the current token. Sign-out (null token) keeps
      // the device-scoped socket when a device credential is available.
      if (!this.socket) return;
      if (token) {
        if (!this.socket.connected) {
          this.socket.connect();
        }
        return;
      }
      const cred = this.host.getDeviceCredential();
      if (cred && !this.socket.connected) {
        this.socket.connect();
      }
    });
    this.openBroadcastChannel();
    // Device-scoped socket: bearer when authenticated, else deviceId+deviceSecret so
    // signed-out tabs still receive `session_state` and can mint on change.
    if (this.host.getAccessToken()) {
      try {
        await this.bootstrap();
      } catch (error) {
        logger.warn('[SessionClient] bootstrap during start failed (non-fatal)', { component: 'SessionClient' }, error);
      }
    }
    await this.connectSocket();
  }

  stop(): void {
    this.started = false;
    if (this.tokenUnsub) {
      this.tokenUnsub();
      this.tokenUnsub = null;
    }
    if (this.channel) {
      this.channel.onmessage = null;
      try {
        this.channel.close();
      } catch (error) {
        logger.debug('[SessionClient] BroadcastChannel close failed', { component: 'SessionClient' }, error);
      }
      this.channel = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.boundServerEvents.clear();
    }
  }

  private async connectSocket(): Promise<void> {
    // Prefer a statically-injected factory (services/auth-sdk bundle
    // socket.io-client as a real dep); fall back to the lazy loader — and warn
    // if THAT yields nothing — only when no factory was injected.
    const io = this.options.socketFactory ?? (await getSocketIO());
    if (!io) {
      logger.warn('[SessionClient] no socket.io-client; running REST-only (no realtime sync)', { component: 'SessionClient' });
      return;
    }
    if (!this.started) return; // stopped while the dynamic import was in flight

    const token = this.host.getAccessToken();
    const deviceCredential = this.host.getDeviceCredential();
    if (!token && !deviceCredential) return;

    const socket = io(this.host.getBaseURL(), {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      auth: (cb: (data: Record<string, string>) => void) => {
        const bearer = this.host.getAccessToken();
        if (bearer) {
          cb({ token: bearer });
          return;
        }
        const cred = this.host.getDeviceCredential();
        if (cred) {
          cb({ deviceId: cred.deviceId, deviceSecret: cred.deviceSecret });
          return;
        }
        cb({ token: '' });
      },
    });
    socket.on('session_state', (payload: unknown) => {
      // A socket broadcast is a `push`-origin — potentially transient, so an
      // empty state here must not erase the durable device credential.
      const applied = this.applyState(payload, 'push');
      if (!applied) return;
      // An identity-bound client tracks the pushed state but NEVER chases the
      // device's active account: re-fetching here would only pull an
      // `activeToken` for somebody else's switch, which the plant guards would
      // then discard. Skip the round-trip entirely.
      if (this.pinnedAccountId() !== null) return;
      // A push changed the active account on another device/tab — re-fetch state
      // to plant the access token for the newly-active account. When this tab is
      // still signed out, applyState mints via ensureActiveToken first; bootstrap
      // requires a bearer and must not run until then.
      const active = this.state?.activeAccountId ?? null;
      if (active && active !== this.host.getCurrentAccountId() && this.host.getAccessToken()) {
        void this.bootstrap().catch((error) => {
          logger.warn('[SessionClient] post-push token fetch failed', { component: 'SessionClient' }, error);
        });
      }
    });
    socket.on(SESSION_ACCOUNTS_CHANGED_EVENT, (payload: unknown) => {
      this.onSessionAccountsChanged(payload);
    });
    this.socket = socket;
    // (Re)bind app-facing server-event subscriptions on the fresh socket.
    this.boundServerEvents.clear();
    for (const event of this.serverEvents.keys()) {
      this.bindServerEvent(event);
    }
  }

  /**
   * Handle the token-free `session_accounts_changed` signal (room `user:<userId>`).
   *
   * Unlike `session_state` (device-scoped, carries the new state to APPLY), this
   * reaches ALL of a user's connected sockets across their devices/origins and is
   * a pure SIGNAL: it carries no token, no secret, and no account bodies. The only
   * trustworthy bit is "something changed for this user", so — matching the
   * `session_state` contract's guidance — we re-fetch our OWN authoritative device
   * state (`bootstrap` → `GET /session/device/state`) and let the existing
   * `applyState` revision guard reconcile it. We never trust any field on the event
   * beyond routing it to the current user.
   *
   * The refetch is a private (bearer) call: the socket only joins `user:<userId>`
   * when authenticated, so a signed-out client never receives this — but we guard
   * the bearer anyway so a race at sign-out can't 401.
   */
  private onSessionAccountsChanged(payload: unknown): void {
    const event = safeParseContract(sessionAccountsChangedEventSchema, payload);
    if (!event) {
      logger.warn('[SessionClient] discarded invalid session_accounts_changed', { component: 'SessionClient' });
      return;
    }
    // The socket is in `user:<activeUserId>` for the planted bearer, so this should
    // always be the current user; ignore a foreign id defensively (out-of-band relay).
    if (event.userId !== this.host.getCurrentAccountId()) return;
    if (!this.host.getAccessToken()) return;
    void this.bootstrap().catch((error) => {
      logger.warn('[SessionClient] session_accounts_changed refetch failed', { component: 'SessionClient' }, error);
    });
  }

  /**
   * Open the same-origin `BroadcastChannel` (web only). A sibling tab that
   * commits an account switch / sign-out posts a wake ping; on receipt an
   * authenticated tab re-syncs its device state — instant + network-free for the
   * common "two tabs of the same origin" case, with no state (and no tokens)
   * ever crossing the channel. No-op on native (no BroadcastChannel).
   */
  private openBroadcastChannel(): void {
    if (this.channel) return;
    const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => SessionBroadcastChannel }).BroadcastChannel;
    if (typeof Ctor !== 'function') return; // native RN / SSR — feature absent
    let channel: SessionBroadcastChannel;
    try {
      channel = new Ctor(SESSION_BROADCAST_CHANNEL);
    } catch (error) {
      logger.debug('[SessionClient] BroadcastChannel unavailable', { component: 'SessionClient' }, error);
      return;
    }
    channel.onmessage = (event) => {
      if (!event || typeof event.data !== 'object' || event.data === null) return;
      if ((event.data as { type?: unknown }).type !== 'commit') return;
      // BroadcastChannel never echoes to the posting context, so this is a
      // sibling's commit. An authenticated tab re-syncs its device state; the
      // re-sync does not re-post, so there is no cross-tab ping loop.
      if (this.host.getAccessToken()) {
        void this.bootstrap().catch((error) => {
          logger.warn('[SessionClient] broadcast re-sync failed', { component: 'SessionClient' }, error);
        });
      }
    };
    this.channel = channel;
  }

  /**
   * Wake same-origin sibling tabs after a locally-initiated session mutation.
   * Opens the channel lazily: a sign-in registers the account (`addCurrentAccount`
   * / `switchAccount`) BEFORE `start()` runs, so the ping must not depend on
   * `start()` having opened the channel first.
   */
  private postCommitPing(): void {
    this.openBroadcastChannel();
    if (!this.channel) return;
    try {
      this.channel.postMessage({ type: 'commit', at: Date.now() });
    } catch (error) {
      logger.debug('[SessionClient] BroadcastChannel post failed', { component: 'SessionClient' }, error);
    }
  }
}
