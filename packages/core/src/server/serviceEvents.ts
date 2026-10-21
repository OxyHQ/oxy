/**
 * The service-event feed: `OxyServer`'s own connection to oxy-api's
 * `/service-events` Socket.IO namespace, which announces every session Oxy
 * ends (`@oxy.so/contracts` `sessionRevocation.ts`).
 *
 * It exists for one consumer, the session-validation cache (`./session.ts`),
 * and its whole job is to answer one question honestly: "may a cached
 * validation be trusted right now?" That is {@link OxyServiceEventFeed.liveEpoch}:
 * a number while the feed is live, `null` otherwise, and a DIFFERENT number
 * after every interruption. The cache stores the epoch with each entry and
 * serves an entry only while the epoch is unchanged, so anything cached before a
 * gap — during which a revocation may have been missed — is never served after
 * it.
 *
 * LIVE means: connected, authenticated with this service's token, and a
 * heartbeat received within `OXY_SERVICE_EVENTS_STALE_AFTER_MS`. oxy-api sends
 * the heartbeat only while its own Valkey round trip works, so a task that can
 * no longer hear revocations stops vouching for the feed and the cache stops
 * being used — a half-open connection is caught by the clock, not by waiting
 * for TCP.
 *
 * The connection is unref'd on Node only: Socket.IO's `autoUnref` is implemented
 * by engine.io-client reaching into the `ws` package's private `ws._socket`,
 * which Bun's WebSocket (what `ws` resolves to under Bun) does not have — core
 * 6.9.0 passed it unconditionally and every Bun backend crashed with
 * `TypeError … this.ws._socket.unref` the first time the feed opened. Under Bun
 * the socket is an ordinary live connection: the feed is opened only by the
 * auth middleware of a serving process, which stays up anyway, and
 * `OxyServer.dispose()` closes it. It reconnects by
 * itself (transport loss: Socket.IO's own backoff; a refusal or a server-side
 * disconnect, e.g. when the service token expires: ours), minting a fresh
 * service token on every attempt.
 *
 * Node-only; used solely by `OxyServer`.
 */
import {
  OXY_SERVICE_EVENTS_FORBIDDEN,
  OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
  OXY_SERVICE_EVENTS_NAMESPACE,
  OXY_SERVICE_EVENTS_STALE_AFTER_MS,
  OXY_SESSION_REVOKED_EVENT,
  oxySessionRevocationEventSchema,
  type OxySessionRevocationEvent,
} from '@oxy.so/contracts';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { logger } from '../logger';

/** First retry after a refusal; doubles to {@link MAX_RETRY_MS}. */
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** A caller oxy-api will never admit (not an internal-tier service) asks again this rarely. */
const FORBIDDEN_RETRY_MS = 10 * 60_000;

export type ServiceEventSocketFactory = (
  url: string,
  options: Partial<ManagerOptions & SocketOptions>,
) => Socket;

export interface OxyServiceEventFeedOptions {
  /** oxy-api's base URL; the namespace is addressed on its origin. */
  baseURL: string;
  /** A current service token for oxy-api. Called on every connection attempt. */
  serviceToken: () => Promise<string>;
  /** A session (or every session of a user) ended. Must not throw. */
  onRevocation: (event: OxySessionRevocationEvent) => void;
  /** The feed stopped being live; whatever it vouched for must be dropped. */
  onDown: () => void;
  /** Tests: the Socket.IO client. */
  connect?: ServiceEventSocketFactory;
  /** Tests: the clock. */
  now?: () => number;
}

/**
 * Whether Socket.IO's `autoUnref` can work here: it calls `ws._socket.unref()`,
 * which exists on Node's `ws` and not on Bun's WebSocket. See the module comment.
 */
export const AUTO_UNREF_SUPPORTED: boolean =
  typeof process === 'undefined' || typeof process.versions?.bun !== 'string';

export class OxyServiceEventFeed {
  private socket: Socket | null = null;
  private live = false;
  private epoch = 0;
  private lastHeartbeat = 0;
  private retryMs = MIN_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: OxyServiceEventFeedOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Open the connection, once. Later calls do nothing. */
  start(): void {
    if (this.socket || this.stopped) return;
    const connect = this.options.connect ?? io;
    const socket = connect(
      `${new URL(this.options.baseURL).origin}${OXY_SERVICE_EVENTS_NAMESPACE}`,
      {
        transports: ['websocket'],
        autoUnref: AUTO_UNREF_SUPPORTED,
        // A NEW Manager: never multiplexed with a user socket to the same origin.
        forceNew: true,
        auth: (callback: (data: object) => void) => {
          this.options.serviceToken().then(
            (token) => callback({ token }),
            // No token: the server refuses, and the refusal is retried with backoff.
            () => callback({}),
          );
        },
      },
    );
    this.socket = socket;

    socket.on(OXY_SERVICE_EVENTS_HEARTBEAT_EVENT, () => this.heartbeat());
    socket.on(OXY_SESSION_REVOKED_EVENT, (payload: unknown) => this.revocation(payload));
    socket.on('connect', () => {
      this.retryMs = MIN_RETRY_MS;
    });
    socket.on('disconnect', (reason: string) => {
      this.down();
      // Socket.IO reconnects by itself after a transport loss, but not after the
      // server closed the socket (an expired token, a task shutting down).
      if (reason === 'io server disconnect') this.retry(MIN_RETRY_MS);
    });
    socket.on('connect_error', (error: Error) => {
      this.down();
      // `active` is false when the namespace middleware refused us; Socket.IO
      // then leaves reconnecting to the caller.
      if (socket.active) return;
      const forbidden = error.message === OXY_SERVICE_EVENTS_FORBIDDEN;
      if (forbidden) {
        logger.warn(
          '[oxy.auth] Oxy refused the service-event feed; session validations stay uncached',
          {
            component: 'auth',
            method: 'serviceEvents',
          },
        );
      }
      this.retry(forbidden ? FORBIDDEN_RETRY_MS : this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    });
  }

  /**
   * The current live period, or `null` when the feed is not live. Two calls
   * return the same number only if the feed was live without interruption in
   * between.
   */
  liveEpoch(): number | null {
    if (this.live && this.now() - this.lastHeartbeat > OXY_SERVICE_EVENTS_STALE_AFTER_MS) {
      this.down();
    }
    return this.live ? this.epoch : null;
  }

  /** Close the connection for good. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.down();
  }

  private heartbeat(): void {
    // A gap longer than the stale window is an interruption even if nobody
    // asked in between: whatever was cached before it must not survive it.
    if (this.live && this.now() - this.lastHeartbeat > OXY_SERVICE_EVENTS_STALE_AFTER_MS) {
      this.down();
    }
    this.lastHeartbeat = this.now();
    if (!this.live) {
      this.live = true;
      this.epoch += 1;
    }
  }

  private revocation(payload: unknown): void {
    const parsed = oxySessionRevocationEventSchema.safeParse(payload);
    if (!parsed.success) {
      // A revocation that cannot be read cannot be applied to one entry: drop all.
      this.down();
      return;
    }
    try {
      this.options.onRevocation(parsed.data);
    } catch (error) {
      logger.warn(
        '[oxy.auth] Session revocation handler failed; dropping every cached validation',
        {
          component: 'auth',
          method: 'serviceEvents',
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this.down(true);
    }
  }

  private down(force = false): void {
    if (!this.live && !force) return;
    this.live = false;
    this.epoch += 1;
    try {
      this.options.onDown();
    } catch {
      // The epoch moved: nothing cached before this point is served again.
    }
  }

  private retry(delayMs: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && this.socket && !this.socket.connected) this.socket.connect();
    }, delayMs);
    this.retryTimer.unref?.();
  }
}
