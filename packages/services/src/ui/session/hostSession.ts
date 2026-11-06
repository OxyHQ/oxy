/**
 * The provider's session source on a platform that holds the Oxy session
 * (ADR 0058 decision 1).
 *
 * Headless: it reads an {@link OxySessionHost} and drives the provider's
 * runtime (ADR 0004) and the client's two auth seams with it. Nothing here
 * persists anything, mints anything, or touches `/session/device/*`:
 *
 *  - `http.setAccessTokenProvider` answers the host's last token from memory;
 *    `http.setAuthRefreshHandler` asks the host (`preflight`, `response-401`).
 *  - A snapshot whose `revision` (or status, or account) changes is ONE context
 *    transition, in ADR 0002's order: the token is dropped and the session
 *    epoch bumped, a token for the new account is awaited, and only then is the
 *    account published.
 *  - Offline the account is published with no token: `canUsePrivateApi` stays
 *    false and the app shows what it cached under that account's id.
 *  - Sign-in, switch, sign-out and account management are the platform's:
 *    {@link HostSession.request} hands them over and changes nothing here.
 */
import type { OxyServices, User } from '@oxy.so/core';
import type {
  OxyHostAccount,
  OxyHostRequest,
  OxyHostSnapshot,
  OxyHostToken,
  OxyHostTokenReason,
  OxySessionHost,
} from '@oxy.so/core/host';
import type { OxyRuntime } from '../runtime';
import { TOKEN_RECOVERY_BACKOFF_MS } from './tokenLossRecovery';

/**
 * Thrown by an operation a hosted provider leaves to the platform that holds
 * the session (ADR 0058 decision 1): a sign-in this app would commit itself,
 * device management, a switch that must return the new account. The platform's
 * own UI does these; the result reaches the app as a snapshot.
 */
export class HostedSessionError extends Error {
  readonly code = 'oxy_session_hosted';

  constructor(readonly operation: string) {
    super(
      `${operation} is done by the platform that holds the Oxy session; its result arrives as the session changes`,
    );
    this.name = 'HostedSessionError';
  }
}

/** How long a context transition waits for the host's token before publishing the account without one. */
export const HOST_TOKEN_DEADLINE_MS = 10_000;

export interface HostSessionOptions {
  host: OxySessionHost;
  oxyServices: OxyServices;
  runtime: OxyRuntime;
  /**
   * The account changed (`'account'`) or a token for the same account arrived
   * or went (`'token'`). The user socket follows this.
   */
  onTokenChange?: (kind: 'account' | 'token') => void;
  logger: (message: string, error?: unknown) => void;
  /** Tests. */
  tokenDeadlineMs?: number;
  /** Tests. */
  retryBackoffMs?: readonly number[];
}

export interface HostSession {
  /** Begin following the host. Returns the disposer; may be started again after it. */
  start(): () => void;
  /** Hand an action to the platform's own UI. Never changes the session itself. */
  request(action: OxyHostRequest): Promise<void>;
  /** Re-read the host's snapshot now, and fetch a token if one is due. */
  refresh(): Promise<void>;
  /** The platform this session comes from. */
  readonly platform: OxySessionHost['platform'];
}

const UNAVAILABLE: OxyHostSnapshot = Object.freeze({
  status: 'unavailable',
  revision: Number.NaN,
  account: null,
  online: false,
});

function validAccount(account: unknown): OxyHostAccount | null {
  if (!account || typeof account !== 'object') return null;
  const candidate = account as Partial<OxyHostAccount>;
  if (typeof candidate.id !== 'string' || !candidate.id) return null;
  if (typeof candidate.handle !== 'string' || !candidate.handle) return null;
  return {
    id: candidate.id,
    handle: candidate.handle,
    ...(typeof candidate.displayName === 'string' && candidate.displayName
      ? { displayName: candidate.displayName }
      : {}),
    ...(typeof candidate.avatar === 'string' && candidate.avatar
      ? { avatar: candidate.avatar }
      : {}),
  };
}

/**
 * The host's snapshot, checked. A host that throws or answers something that is
 * not a snapshot is `unavailable` — signed out, never a reason to sign in here.
 */
export function readHostSnapshot(host: OxySessionHost): OxyHostSnapshot {
  let raw: unknown;
  try {
    raw = host.snapshot();
  } catch {
    return UNAVAILABLE;
  }
  if (!raw || typeof raw !== 'object') return UNAVAILABLE;
  const candidate = raw as Partial<OxyHostSnapshot>;
  if (typeof candidate.revision !== 'number' || !Number.isFinite(candidate.revision)) {
    return UNAVAILABLE;
  }
  const online = candidate.online === true;
  if (candidate.status === 'signed_in') {
    const account = validAccount(candidate.account);
    if (!account) return UNAVAILABLE;
    return { status: 'signed_in', revision: candidate.revision, account, online };
  }
  if (candidate.status === 'signed_out' || candidate.status === 'unavailable') {
    return { status: candidate.status, revision: candidate.revision, account: null, online };
  }
  return UNAVAILABLE;
}

/** The provider's `User` for the snapshot's account, over what the API said about it. */
export function userFromHostAccount(account: OxyHostAccount, base: User | null): User {
  const known = base && base.id === account.id ? base : null;
  const name = { ...(known?.name ?? {}) };
  if (account.displayName) name.displayName = account.displayName;
  return {
    ...(known ?? {}),
    id: account.id,
    username: account.handle,
    publicKey: known?.publicKey ?? '',
    name,
    avatar: account.avatar ?? known?.avatar ?? null,
  } as User;
}

function sameProfile(user: User | null, account: OxyHostAccount): boolean {
  return (
    user !== null &&
    user.id === account.id &&
    user.username === account.handle &&
    (account.displayName === undefined || user.name?.displayName === account.displayName) &&
    (account.avatar === undefined || user.avatar === account.avatar)
  );
}

interface Applied {
  revision: number;
  status: OxyHostSnapshot['status'];
  accountId: string | null;
  online: boolean;
}

export function createHostSession(options: HostSessionOptions): HostSession {
  const { host, oxyServices, runtime, logger } = options;
  const deadlineMs = options.tokenDeadlineMs ?? HOST_TOKEN_DEADLINE_MS;
  const backoff = options.retryBackoffMs ?? TOKEN_RECOVERY_BACKOFF_MS;

  let running = false;
  let applied: Applied | null = null;
  /** Bumped by every context transition and by stop: a result for an older one plants nothing. */
  let seq = 0;
  let token: OxyHostToken | null = null;
  /** True while this module itself writes the client's token, so its own write is not taken for a loss. */
  let writing = false;
  let pendingToken: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let enrichedFor = -1;

  const cancelRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** What the host returned, if it is a token at all (whose token it is is checked once planted). */
  const accept = (candidate: unknown): OxyHostToken | null => {
    if (!candidate || typeof candidate !== 'object') return null;
    const { accessToken, expiresAt } = candidate as Partial<OxyHostToken>;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    return { accessToken, expiresAt: typeof expiresAt === 'string' ? expiresAt : '' };
  };

  const ask = async (reason: OxyHostTokenReason): Promise<OxyHostToken | null> => {
    try {
      return accept(await host.getAccessToken({ reason }));
    } catch (error) {
      logger('The session host could not give a token', error);
      return null;
    }
  };

  const writeToken = (next: OxyHostToken | null): void => {
    writing = true;
    try {
      if (next) {
        oxyServices.session.setAccessToken(next.accessToken);
      } else {
        // Drops the bearer, bumps the session epoch and abandons every refresh
        // in flight, so nothing minted for the previous account lands after it.
        oxyServices.session.clear();
      }
    } finally {
      writing = false;
    }
  };

  /** Plant `next` for `accountId`; false when the token names somebody else. */
  const plant = (next: OxyHostToken, accountId: string): boolean => {
    token = next;
    writeToken(next);
    const subject = oxyServices.session.userId;
    if (subject !== null && subject !== accountId) {
      logger('The session host gave a token for another account; it was dropped');
      token = null;
      writeToken(null);
      runtime.setHasAccessToken(false);
      return false;
    }
    runtime.setHasAccessToken(true);
    return true;
  };

  /** The shared session the planted token names, or none without a token. */
  const publishSessionId = (accountId: string | null): void => {
    const sessionId = accountId && token ? oxyServices.session.sessionId : null;
    if (runtime.getSnapshot().activeSessionId === sessionId) return;
    if (!accountId || !sessionId) {
      runtime.batch(() => {
        runtime.mergeSessions([], { merge: false });
        runtime.setActiveSessionId(null);
      });
      return;
    }
    const now = new Date().toISOString();
    runtime.batch(() => {
      runtime.mergeSessions(
        [
          {
            sessionId,
            deviceId: '',
            expiresAt: token?.expiresAt || now,
            lastActive: now,
            userId: accountId,
            isCurrent: true,
          },
        ],
        { merge: false },
      );
      runtime.setActiveSessionId(sessionId);
    });
  };

  /** Read the full profile once a token is held, for this transition only. */
  const enrich = (account: OxyHostAccount): void => {
    const forSeq = seq;
    if (enrichedFor === forSeq) return;
    enrichedFor = forSeq;
    void oxyServices.users
      .me()
      .then((me) => {
        if (forSeq !== seq || !running || !me || me.id !== account.id) return;
        const current = readHostSnapshot(host);
        const latest = current.account?.id === account.id ? current.account : account;
        runtime.setAccount(userFromHostAccount(latest, me));
      })
      .catch((error) => {
        enrichedFor = -1;
        logger('Could not read the signed-in profile', error);
      });
  };

  const scheduleRetry = (): void => {
    if (!running || retryTimer !== null) return;
    if (applied?.status !== 'signed_in' || !applied.online || token) return;
    const delay = backoff[Math.min(retryAttempt, backoff.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void ensureToken('preflight');
    }, delay);
  };

  /**
   * Get a token for the applied account when none is held (reconnecting, a
   * token lost to a 401, a slow first answer). One at a time.
   */
  const ensureToken = (reason: OxyHostTokenReason): Promise<void> => {
    if (pendingToken) return pendingToken;
    const forSeq = seq;
    const accountId = applied?.status === 'signed_in' ? applied.accountId : null;
    if (!running || !accountId || token) return Promise.resolve();
    pendingToken = (async () => {
      const next = await ask(reason);
      if (forSeq !== seq || !running || token) return;
      let planted = false;
      runtime.batch(() => {
        planted = next !== null && plant(next, accountId);
        if (!planted) return;
        publishSessionId(accountId);
        runtime.setTokenReady(true);
      });
      if (planted) {
        retryAttempt = 0;
        cancelRetry();
        options.onTokenChange?.('token');
        const account = readHostSnapshot(host).account;
        if (account?.id === accountId) enrich(account);
        return;
      }
      scheduleRetry();
    })().finally(() => {
      pendingToken = null;
    });
    return pendingToken;
  };

  const signedOut = (): void => {
    runtime.batch(() => {
      runtime.clearSession();
      runtime.markAuthResolved();
    });
  };

  const transition = async (snapshot: OxyHostSnapshot): Promise<void> => {
    seq += 1;
    const forSeq = seq;
    cancelRetry();
    retryAttempt = 0;
    applied = {
      revision: snapshot.revision,
      status: snapshot.status,
      accountId: snapshot.account?.id ?? null,
      online: snapshot.online,
    };
    // 1. Drop the token and bump the epoch before anything else can run.
    token = null;
    writeToken(null);
    runtime.setHasAccessToken(false);
    options.onTokenChange?.('account');

    const account = snapshot.status === 'signed_in' ? snapshot.account : null;
    if (!account) {
      signedOut();
      return;
    }

    // 2. Await a token for the new account; the previous account stays on
    // screen meanwhile with no token, so nothing private runs for anybody.
    runtime.setTokenReady(false);
    let settled = false;
    const answer = ask('boot').then((next) => {
      settled = true;
      return next;
    });
    const deadline = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), deadlineMs);
      void answer.finally(() => clearTimeout(timer));
    });
    const next = await Promise.race([answer, deadline]);
    if (forSeq !== seq || !running) return;

    // 3. Plant it and only then publish the account, in ONE runtime transition
    // (the account-scoped cache reset runs inside it, before anyone is woken).
    let planted = false;
    runtime.batch(() => {
      planted = next !== null && plant(next, account.id);
      publishSessionId(planted ? account.id : null);
      runtime.setAccount(userFromHostAccount(account, runtime.getSnapshot().account));
      runtime.setTokenReady(true);
      runtime.markAuthResolved();
    });
    if (planted) {
      options.onTokenChange?.('token');
      enrich(account);
      return;
    }
    if (!settled) {
      // The host is slow: the account is shown without a token, and the token
      // is planted when it arrives (if this is still the account).
      void answer.then((late) => {
        if (forSeq !== seq || !running || token) return;
        let latePlanted = false;
        runtime.batch(() => {
          latePlanted = late !== null && plant(late, account.id);
          if (latePlanted) publishSessionId(account.id);
        });
        if (latePlanted) {
          options.onTokenChange?.('token');
          enrich(account);
          return;
        }
        scheduleRetry();
      });
      return;
    }
    scheduleRetry();
  };

  const apply = (snapshot: OxyHostSnapshot): void => {
    const previous = applied;
    if (
      previous === null ||
      !Object.is(previous.revision, snapshot.revision) ||
      previous.status !== snapshot.status ||
      previous.accountId !== (snapshot.account?.id ?? null)
    ) {
      void transition(snapshot).catch((error) => {
        logger('The session host transition failed', error);
      });
      return;
    }
    // The same context: the profile, or the platform going on or offline.
    const wasOnline = previous.online;
    applied = { ...previous, online: snapshot.online };
    const account = snapshot.account;
    if (!account) return;
    const current = runtime.getSnapshot().account;
    if (current && current.id === account.id && !sameProfile(current, account)) {
      runtime.setAccount(userFromHostAccount(account, current));
    }
    if (snapshot.online && !token) {
      if (!wasOnline) {
        retryAttempt = 0;
        cancelRetry();
      }
      void ensureToken('preflight');
    }
  };

  const onClientToken = (accessToken: string | null): void => {
    if (writing) return;
    runtime.setHasAccessToken(Boolean(accessToken));
    if (accessToken) return;
    // The client dropped the bearer itself: a 401 the host's fresh token could
    // not answer either. Forget it and ask again, with backoff.
    if (token) {
      token = null;
      options.onTokenChange?.('token');
      scheduleRetry();
    }
  };

  return {
    platform: host.platform,

    start() {
      running = true;
      applied = null;
      oxyServices.http.setAccessTokenProvider(() => token?.accessToken ?? null);
      oxyServices.http.setAuthRefreshHandler(async (reason) => {
        const forSeq = seq;
        const accountId = applied?.status === 'signed_in' ? applied.accountId : null;
        if (!running || !accountId) return null;
        const next = await ask(reason);
        if (forSeq !== seq || !running) return null;
        if (!next) return null;
        const hadToken = token !== null;
        if (!plant(next, accountId)) return null;
        if (!hadToken) options.onTokenChange?.('token');
        return next.accessToken;
      });
      const unsubscribeToken = oxyServices.session.onChange(onClientToken);
      let unsubscribeHost: () => void = () => undefined;
      try {
        unsubscribeHost = host.subscribe(() => {
          if (running) apply(readHostSnapshot(host));
        });
      } catch (error) {
        logger('Could not subscribe to the session host', error);
      }
      apply(readHostSnapshot(host));

      return () => {
        running = false;
        seq += 1;
        cancelRetry();
        unsubscribeToken();
        try {
          unsubscribeHost();
        } catch (error) {
          logger('Could not unsubscribe from the session host', error);
        }
        oxyServices.http.setAuthRefreshHandler(null);
        oxyServices.http.setAccessTokenProvider(null);
        token = null;
        writeToken(null);
      };
    },

    async request(action) {
      try {
        await host.request(action);
      } catch (error) {
        logger(`The session host could not ${action.replace('_', ' ')}`, error);
        throw error;
      }
    },

    async refresh() {
      if (!running) return;
      apply(readHostSnapshot(host));
      if (applied?.status === 'signed_in' && !token) await ensureToken('preflight');
    },
  };
}
