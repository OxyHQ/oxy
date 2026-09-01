import type { DeviceDirectory, DeviceSessionState } from '@oxyhq/contracts';
import type { ClientSession, DeviceContext, User } from '@oxyhq/core';
import {
  accountIdsOf,
  activeSessionIdOf,
  activeUserOf,
  deviceStateToClientSessions,
  mergeSessions as mergeSessionLists,
  normalizeAndSortSessions,
  normalizeUserIdentity,
  resolveActiveContext,
  sessionsArraysEqual,
} from '@oxyhq/core';
import type { IdentitySessionBinding } from '../session/identityBinding';
import type { OxyRuntimeSnapshot, OxyRuntimeStatus, OxyTokenStatus } from './types';

/**
 * A change of SUBJECT — the account the session acts as.
 *
 * `previous === null` is an initial sign-in (nothing account-scoped is cached
 * yet); `next === null` is a sign-out; both non-null and different is a switch,
 * the only case that must invalidate a warm cache.
 */
export interface SubjectTransition {
  previous: string | null;
  next: string | null;
}

/**
 * The three seams the runtime reads, declared STRUCTURALLY rather than as the
 * concrete `OxyServices` / `SessionClient` / `SessionClientHost` types.
 *
 * The real classes satisfy them, so nothing changes at the call site — but a
 * test can hand the runtime three plain objects instead of casting a stub
 * through `unknown`, which is how a stub silently drifts from the interface it
 * pretends to implement.
 */
export interface RuntimeClient {
  getAccessToken(): string | null;
  getUsersByIds(ids: string[]): Promise<User[]>;
}

export interface RuntimeSessionClient {
  getState(): DeviceSessionState | null;
  getDirectory(): DeviceDirectory | null;
  subscribe(listener: (state: DeviceSessionState | null) => void): () => void;
  refreshDirectory(): Promise<void>;
  activateContext(contextId: string): Promise<void>;
  signOutContext(contextId: string): Promise<void>;
  signOutPrincipal(principalId: string): Promise<void>;
}

export interface RuntimeSessionHost {
  setCurrentAccountId(accountId: string | null): void;
}

export interface OxyRuntimeConfig {
  oxyServices: RuntimeClient;
  sessionClient: RuntimeSessionClient;
  sessionClientHost: RuntimeSessionHost;
  /** `null` for every account-mode runtime; the pin binding in identity mode. */
  identity: IdentitySessionBinding | null;

  /**
   * Reset account-scoped caches. Called BETWEEN the bearer commit and the
   * snapshot publish, which is the whole point of routing every fact change
   * through one transition (ADR 0002's ordering invariant): a consumer woken by
   * a switch must never read a cache entry belonging to the previous subject.
   */
  onSubjectChange?: (transition: SubjectTransition) => void;

  /**
   * The device reports zero accounts. Local UI teardown only — the durable
   * device credential is the caller's decision, gated on a `request`-origin
   * verdict.
   */
  onDeviceEmpty: () => Promise<void>;

  /** Persist the projected session-id list (display/bookkeeping storage). */
  onSessionsProjected?: (sessionIds: string[]) => void;

  /**
   * Identity mode only: the pinned account is unknown or has left this device's
   * session set, so the session must be re-derived from the local identity key.
   * Projecting anything here would mean projecting somebody else's account.
   */
  onIdentityUnbound?: (binding: IdentitySessionBinding, revision: number) => void;

  logger: (message: string, error?: unknown) => void;
}

/**
 * The headless session runtime (ADR 0004).
 *
 * It owns the session facts and the ORDER in which they become visible. React
 * is an adapter: the provider hands components this object and they subscribe
 * with selectors, so an unrelated change (a locale, a dialog opening) cannot
 * rebuild an auth consumer's view.
 */
export interface OxyRuntime {
  getSnapshot(): OxyRuntimeSnapshot;
  subscribe(listener: () => void): () => void;

  /** Begin projecting `SessionClient` transitions. Returns the disposer. */
  start(): () => void;

  /**
   * Project the client's current device state onto the snapshot. Idempotent and
   * revision-guarded: a projection whose profile fetch was overtaken by a
   * fresher state discards itself rather than publishing a stale subject.
   */
  reconcileFromClient(): Promise<void>;

  /** Read the device directory and publish it (opts this runtime into ADR 0002). */
  refreshDirectory(): Promise<void>;

  /**
   * Make one `principal acting as account` context active (ADR 0002).
   *
   * `contextId`, never an account id: on a device holding two people the same
   * organization is reachable through both, and an account id cannot name which
   * route to take.
   */
  activateContext(contextId: string): Promise<void>;

  /**
   * Remove ONE `principal → account` pair. The same account reached through a
   * second person is a different session with a different audit actor, and it
   * stays.
   *
   * Context ids are NOT stable across a removal: the server offers the pair
   * again under a NEW id on the next directory read, so nothing may cache one
   * across this call.
   */
  signOutContext(contextId: string): Promise<void>;

  /** Remove ONE PERSON and every context they reach, and nobody else's. */
  signOutPrincipal(principalId: string): Promise<void>;

  /**
   * Run several fact changes as ONE transition.
   *
   * A session commit sets the optimistic session mirror, the active session id
   * and the account. Left as three transitions those are three publishes, and
   * — worse — the account is compared against a different baseline each time,
   * so an account-scoped cache reset could run against a half-applied session.
   * Batched, subscribers are woken once, after all of it, with the reset having
   * run exactly once in between.
   */
  batch(mutate: () => void): void;

  setAccount(user: User): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setStorageReady(ready: boolean): void;
  setTokenReady(ready: boolean): void;
  setHasAccessToken(has: boolean): void;
  setSwitching(switching: boolean): void;
  markAuthResolved(): void;

  /**
   * Merge an optimistic local session mirror so the UI moves before the server
   * round-trip. The authoritative projection overwrites it a moment later; both
   * write the SAME field, so there is still exactly one owner.
   */
  mergeSessions(incoming: ClientSession[], options?: { merge?: boolean; preserveSessionIds?: string[] }): void;
  setActiveSessionId(sessionId: string | null): void;

  /** Local teardown: drop the session projection without touching the server. */
  clearSession(): void;
}

interface RuntimeFacts {
  deviceState: DeviceSessionState | null;
  directory: DeviceDirectory | null;
  profiles: Map<string, User>;
  sessions: ClientSession[];
  activeSessionId: string | null;
  account: User | null;
  pinnedAccountId: string | null;
  isLoading: boolean;
  error: string | null;
  storageReady: boolean;
  tokenReady: boolean;
  hasAccessToken: boolean;
  authResolved: boolean;
  switching: boolean;
}

const EMPTY_SESSIONS: ClientSession[] = [];

function deriveStatus(facts: RuntimeFacts): OxyRuntimeStatus {
  if (!facts.authResolved) {
    return 'booting';
  }
  if (facts.account !== null) {
    return 'authenticated';
  }
  return facts.error !== null ? 'error' : 'signed_out';
}

function deriveTokenStatus(facts: RuntimeFacts): OxyTokenStatus {
  if (facts.hasAccessToken && facts.tokenReady) {
    return 'ready';
  }
  if (facts.account !== null || facts.hasAccessToken) {
    return 'refreshing';
  }
  return 'missing';
}

/**
 * The actor behind the active context, resolved to a full `User`.
 *
 * Falls back to the subject: on a device with no directory, and on any
 * non-delegated context, the two ARE the same person, and saying so is more
 * useful than a `null` every caller would have to special-case.
 */
function derivePrincipal(
  activeContext: DeviceContext | null,
  profiles: Map<string, User>,
  account: User | null,
): User | null {
  if (activeContext === null) {
    return account;
  }
  return profiles.get(activeContext.actor.userId) ?? account;
}

export function createOxyRuntime(config: OxyRuntimeConfig): OxyRuntime {
  const {
    oxyServices,
    sessionClient,
    sessionClientHost,
    identity,
    onSubjectChange,
    onDeviceEmpty,
    onSessionsProjected,
    onIdentityUnbound,
    logger,
  } = config;

  const facts: RuntimeFacts = {
    deviceState: null,
    directory: null,
    profiles: new Map(),
    sessions: EMPTY_SESSIONS,
    activeSessionId: null,
    account: null,
    pinnedAccountId: null,
    isLoading: false,
    error: null,
    storageReady: false,
    tokenReady: true,
    hasAccessToken: Boolean(oxyServices.getAccessToken()),
    authResolved: false,
    switching: false,
  };

  const listeners = new Set<() => void>();
  let snapshot = buildSnapshot();
  /**
   * Depth of the current transition. Nested mutations publish ONCE, at the
   * outermost boundary — a projection that sets sessions, the active id and the
   * account must not wake React three times with two of them half-applied.
   */
  let depth = 0;
  let dirty = false;
  /** The subject as it stood when the OUTERMOST transition opened. */
  let subjectAtEntry: string | null = null;

  function buildSnapshot(): OxyRuntimeSnapshot {
    const activeContext = resolveActiveContext(facts.directory);
    return Object.freeze({
      status: deriveStatus(facts),
      device: facts.directory,
      deviceState: facts.deviceState,
      activeContext,
      principal: derivePrincipal(activeContext, facts.profiles, facts.account),
      account: facts.account,
      tokenStatus: deriveTokenStatus(facts),
      authResolved: facts.authResolved,
      switching: facts.switching,
      error: facts.error === null ? null : { message: facts.error, code: 'oxy_runtime_error' },
      sessions: facts.sessions,
      activeSessionId: facts.activeSessionId,
      isLoading: facts.isLoading,
      storageReady: facts.storageReady,
      hasAccessToken: facts.hasAccessToken,
      tokenReady: facts.tokenReady,
    });
  }

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        logger('An OxyRuntime subscriber threw', error);
      }
    }
  }

  /**
   * The ONE ordered transition. Every fact change goes through here, so the
   * sequence ADR 0002 mandates holds for a local switch, a socket push, a cold
   * boot and a cross-tab wake alike:
   *
   *   the bearer is already committed (SessionClient awaits its mint before it
   *   calls us) → reset account-scoped caches → publish the snapshot → notify.
   *
   * Publishing before the reset would let a woken component read a cache entry
   * belonging to the previous subject while holding the new subject's bearer,
   * which is the account-switch race in its quietest form: no error, just the
   * wrong person's data.
   */
  function transition(mutate: () => void): void {
    if (depth === 0) {
      subjectAtEntry = facts.account?.id ?? null;
    }
    depth += 1;
    try {
      mutate();
    } finally {
      depth -= 1;
    }
    if (depth > 0) {
      // A nested transition publishes nothing and fires no reset: the subject
      // is compared once, at the outermost boundary, so a projection that
      // touches the account twice cannot reset the caches twice.
      return;
    }
    const nextSubject = facts.account?.id ?? null;
    if (nextSubject !== subjectAtEntry) {
      dirty = true;
      onSubjectChange?.({ previous: subjectAtEntry, next: nextSubject });
    }
    if (!dirty) {
      return;
    }
    dirty = false;
    snapshot = buildSnapshot();
    notify();
  }

  /** Mark the snapshot stale from inside a transition. */
  function touch(): void {
    dirty = true;
  }

  function setSessions(next: ClientSession[]): void {
    if (sessionsArraysEqual(facts.sessions, next)) {
      return;
    }
    facts.sessions = next;
    touch();
  }

  function setActiveSessionIdFact(sessionId: string | null): void {
    if (facts.activeSessionId === sessionId) {
      return;
    }
    facts.activeSessionId = sessionId;
    touch();
  }

  /**
   * The one place a `User` becomes THE subject — and the one place identity is
   * normalised, so a profile arriving as `_id` from one lane and `id` from
   * another can never produce two accounts that are the same person.
   */
  function setAccountFact(user: User | null): void {
    if (user === null) {
      if (facts.account === null) {
        return;
      }
      facts.account = null;
      touch();
      return;
    }
    if (facts.account === user) {
      return;
    }
    facts.account = normalizeUserIdentity(user);
    touch();
  }

  // ── Projection ───────────────────────────────────────────────────────────

  async function reconcileFromClient(): Promise<void> {
    const state = sessionClient.getState();
    if (state === null) {
      return;
    }
    if (state.accounts.length === 0) {
      sessionClientHost.setCurrentAccountId(null);
      await onDeviceEmpty();
      return;
    }
    // Capture the revision this projection is for, then bail after the async
    // profile fetch if a fresher state has landed — last-writer-wins, so two
    // overlapping projections can never publish in the wrong order.
    const capturedRevision = state.revision;
    // Resolve the pin BEFORE the fetch (memoised: one storage + keychain read
    // per boot) so the first pass over a freshly applied state is already bound.
    // Deferring it would let a sibling app's switch render once as this
    // client's user before the pin corrected it.
    const pinnedAccountId = identity ? await identity.ensurePinnedAccountId() : null;
    const ids = accountIdsOf(state);
    let users: User[] = [];
    try {
      users = ids.length > 0 ? await oxyServices.getUsersByIds(ids) : [];
    } catch (fetchError) {
      logger('Failed to resolve account profiles during the device projection', fetchError);
      return;
    }
    const latest = sessionClient.getState();
    if (!latest || latest.revision !== capturedRevision) {
      return;
    }
    if (identity && (pinnedAccountId === null || activeSessionIdOf(latest, pinnedAccountId) === null)) {
      // Either no verified pin, or the pinned account left this device's session
      // set. Leave the current projection untouched and re-derive from the key.
      onIdentityUnbound?.(identity, latest.revision);
      return;
    }
    const directory = sessionClient.getDirectory();
    transition(() => {
      facts.pinnedAccountId = pinnedAccountId;
      if (facts.deviceState !== latest) {
        facts.deviceState = latest;
        touch();
      }
      if (facts.directory !== directory) {
        facts.directory = directory;
        touch();
      }
      for (const resolved of users) {
        facts.profiles.set(resolved.id, resolved);
      }
      const projected = normalizeAndSortSessions(
        deviceStateToClientSessions(latest, facts.profiles, pinnedAccountId),
        facts.activeSessionId,
        false,
      );
      setSessions(projected);
      onSessionsProjected?.(projected.map((session) => session.sessionId));
      setActiveSessionIdFact(activeSessionIdOf(latest, pinnedAccountId));
      const activeUser = activeUserOf(latest, facts.profiles, pinnedAccountId);
      if (activeUser) {
        setAccountFact(activeUser);
      }
    });
    // The host's current account feeds the socket handshake and the bearer's
    // token-account comparisons, so it tracks the PIN — never the account
    // another app switched the device to.
    sessionClientHost.setCurrentAccountId(pinnedAccountId ?? latest.activeAccountId);
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      return sessionClient.subscribe(() => {
        void reconcileFromClient().catch((error) => {
          logger('Failed to project a device-state transition', error);
        });
      });
    },

    reconcileFromClient,

    batch(mutate) {
      transition(mutate);
    },

    async activateContext(contextId) {
      // `switching` is published BEFORE the request so a switcher can disable
      // its rows for the whole round trip, and cleared in `finally` so a
      // refused activation does not strand it on.
      this.setSwitching(true);
      try {
        await sessionClient.activateContext(contextId);
        await reconcileFromClient();
      } finally {
        this.setSwitching(false);
      }
    },

    async signOutContext(contextId) {
      await sessionClient.signOutContext(contextId);
      await reconcileFromClient();
    },

    async signOutPrincipal(principalId) {
      await sessionClient.signOutPrincipal(principalId);
      await reconcileFromClient();
    },

    async refreshDirectory() {
      await sessionClient.refreshDirectory();
      const directory = sessionClient.getDirectory();
      transition(() => {
        if (facts.directory === directory) {
          return;
        }
        facts.directory = directory;
        touch();
      });
    },

    setAccount(user) {
      transition(() => {
        setAccountFact(user);
        if (facts.isLoading) {
          facts.isLoading = false;
          touch();
        }
        if (facts.error !== null) {
          facts.error = null;
          touch();
        }
        facts.profiles.set(user.id, user);
      });
    },

    setLoading(loading) {
      transition(() => {
        if (facts.isLoading === loading) return;
        facts.isLoading = loading;
        touch();
      });
    },

    setError(error) {
      transition(() => {
        if (facts.error === error) return;
        facts.error = error;
        touch();
      });
    },

    setStorageReady(ready) {
      transition(() => {
        if (facts.storageReady === ready) return;
        facts.storageReady = ready;
        touch();
      });
    },

    setTokenReady(ready) {
      transition(() => {
        if (facts.tokenReady === ready) return;
        facts.tokenReady = ready;
        touch();
      });
    },

    setHasAccessToken(has) {
      transition(() => {
        if (facts.hasAccessToken === has) return;
        facts.hasAccessToken = has;
        touch();
      });
    },

    setSwitching(switching) {
      transition(() => {
        if (facts.switching === switching) return;
        facts.switching = switching;
        touch();
      });
    },

    markAuthResolved() {
      transition(() => {
        if (facts.authResolved) return;
        facts.authResolved = true;
        facts.tokenReady = true;
        touch();
      });
    },

    mergeSessions(incoming, options = {}) {
      transition(() => {
        const processed = options.merge
          ? mergeSessionLists(facts.sessions, incoming, facts.activeSessionId, false)
          : normalizeAndSortSessions(incoming, facts.activeSessionId, false);
        onSessionsProjected?.([
          ...processed.map((session) => session.sessionId),
          ...(options.preserveSessionIds ?? []),
        ]);
        setSessions(processed);
      });
    },

    setActiveSessionId(sessionId) {
      transition(() => {
        setActiveSessionIdFact(sessionId);
      });
    },

    clearSession() {
      transition(() => {
        setSessions(EMPTY_SESSIONS);
        setActiveSessionIdFact(null);
        setAccountFact(null);
        facts.deviceState = null;
        facts.directory = null;
        facts.profiles = new Map();
        facts.pinnedAccountId = null;
        touch();
      });
    },
  };
}
