/**
 * Oxy user-invalidation publish/consume helpers for Oxy backends.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Oxy backend caches Oxy identity, and none of them find out when it
 * changes. The `OxyServices` GET response cache holds `GET /users/:id` and
 * `GET /profiles/username/:name` for five minutes; it is swept when THIS process
 * writes the profile (the `evictOxyIdentityCache` calls in the user and accounts
 * mixins) and never when somebody else does — which is the normal case, since
 * profiles are edited in Oxy's own apps. So an avatar or display-name change is
 * invisible to every consuming backend for up to five minutes, per process.
 *
 * oxy-api broadcasts {@link OXY_USER_INVALIDATION_CHANNEL} on the shared Valkey
 * when a user's identity changes. This module is the consumer half: it parses
 * and validates the event, sweeps the SDK's own cache, and hands the event to
 * app-specific eviction. Wiring it is two lines and every backend that does so
 * stops serving stale identity.
 *
 * WHY THE TRANSPORT IS THE CALLER'S JOB
 * -------------------------------------
 * This module deliberately does NOT take a Redis client. ioredis and node-redis
 * disagree about how to subscribe — node-redis passes the listener to
 * `subscribe(channel, listener)`, ioredis takes `subscribe(channel)` and then
 * emits `'message'` on the client — and a helper that accepted "a client" would
 * have to sniff which library it was handed. That kind of detection is exactly
 * what breaks silently when a consumer upgrades a client library.
 *
 * So the split is: this module owns parsing, validation, dispatch and the
 * never-throw guarantee (the parts that are easy to get wrong and identical
 * everywhere), and the caller owns its own client's two-line subscribe idiom
 * (trivial, but library-specific).
 *
 *     // node-redis
 *     await subscriber.subscribe(
 *       OXY_USER_INVALIDATION_CHANNEL,
 *       createOxyUserInvalidationHandler({ oxy: oxyClient }),
 *     );
 *
 *     // ioredis
 *     const handle = createOxyUserInvalidationHandler({ oxy: oxyClient });
 *     await subscriber.subscribe(OXY_USER_INVALIDATION_CHANNEL);
 *     subscriber.on('message', (_channel, raw) => handle(raw));
 *
 * Subscribe on EVERY task, not just an elected leader. The SDK cache this sweeps
 * is per-process in-memory, so a leader-only subscriber would leave every other
 * task stale — and leader-gating would add a failure mode (leader down means no
 * invalidation anywhere) to a signal whose whole point is that losing it is
 * merely slow, never wrong.
 *
 * Node-only; exported solely from `@oxyhq/core/server`.
 */

import {
  OXY_USER_INVALIDATION_CHANNEL,
  isPublishedOxyUserChangeReason,
  oxyUserInvalidationEventSchema,
  type OxyUserChangeReason,
  type OxyUserInvalidationEvent,
} from '@oxyhq/contracts';
import {
  evictOxyIdentityCache,
  type OxyIdentityCacheEvictor,
} from '../utils/identityCacheSweep';

/**
 * The publish surface of a Redis client. Both `ioredis` and `node-redis`
 * satisfy this structurally, so neither library is a dependency here.
 */
export interface OxyInvalidationPublisher {
  publish(channel: string, message: string): unknown;
}

/**
 * Broadcast that an Oxy user's record changed.
 *
 * Returns `true` when a message was put on the wire and `false` when the reason
 * is not a broadcast one ({@link isPublishedOxyUserChangeReason}) — the latter is
 * a deliberate no-op, not a failure. Suppressing at the publisher rather than
 * letting every subscriber discard matters at bulk-follow scale, where a single
 * call moves up to 200 edges.
 *
 * NEVER THROWS AND NEVER RETURNS A REJECTED PROMISE. This is called from inside
 * cache invalidation, which itself runs after a successful database write on the
 * request path: a publish failure must not turn a completed profile update into
 * a 500. A dropped message costs a consumer its TTL and nothing more.
 *
 * @param publisher - A connected Redis client. Must NOT be a client currently in
 *                    subscriber mode — Redis forbids `PUBLISH` on a subscribed
 *                    connection, so pass the publisher half of a pub/sub pair.
 * @param userId    - The Oxy user whose record changed.
 * @param reason    - How the record changed. See {@link OxyUserChangeReason}.
 * @param onError   - Optional diagnostic sink for a failed publish.
 */
export function publishOxyUserInvalidation(
  publisher: OxyInvalidationPublisher,
  userId: string,
  reason: OxyUserChangeReason,
  onError?: (error: unknown) => void,
): boolean {
  if (!userId || !isPublishedOxyUserChangeReason(reason)) {
    return false;
  }

  const event: OxyUserInvalidationEvent = { userId, reason, at: Date.now() };

  try {
    const result = publisher.publish(OXY_USER_INVALIDATION_CHANNEL, JSON.stringify(event));
    // node-redis returns a promise; ioredis returns a promise too, but a mocked
    // or synchronous client may return anything. Only attach a rejection handler
    // when there is actually something thenable to reject.
    if (isPromiseLike(result)) {
      Promise.resolve(result).catch((error: unknown) => onError?.(error));
    }
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Options for {@link createOxyUserInvalidationHandler}. */
export interface OxyUserInvalidationHandlerOptions {
  /**
   * The backend's `OxyServices` instance. When supplied, its GET response cache
   * is swept for the invalidated user — this is the whole reason a backend that
   * has no cache of its own still benefits from subscribing.
   */
  oxy?: OxyIdentityCacheEvictor;
  /**
   * App-specific eviction (e.g. a Redis identity cache the app maintains itself).
   * May be async; a rejection is routed to `onError` and never escapes.
   */
  onInvalidate?: (event: OxyUserInvalidationEvent) => void | Promise<void>;
  /** Diagnostic sink for an unparseable message or a failing `onInvalidate`. */
  onError?: (error: unknown, raw: string) => void;
}

/**
 * Build the message handler for {@link OXY_USER_INVALIDATION_CHANNEL}.
 *
 * The returned function NEVER THROWS and never returns a rejected promise. It
 * runs inside the Redis client's message dispatch, where an exception either
 * takes down the subscriber connection or surfaces as an unhandled rejection —
 * and losing the subscription is strictly worse than losing one message, because
 * it is silent and permanent.
 *
 * A message that fails schema validation is dropped, not retried: the payload is
 * produced by a contract both sides compile against, so a malformed one means a
 * version skew or an unrelated publisher on the channel, neither of which a retry
 * fixes.
 */
export function createOxyUserInvalidationHandler(
  options: OxyUserInvalidationHandlerOptions = {},
): (raw: string) => void {
  const { oxy, onInvalidate, onError } = options;

  return (raw: string): void => {
    let event: OxyUserInvalidationEvent;
    try {
      const parsed = oxyUserInvalidationEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        onError?.(parsed.error, raw);
        return;
      }
      event = parsed.data;
    } catch (error) {
      onError?.(error, raw);
      return;
    }

    if (oxy) {
      try {
        evictOxyIdentityCache(oxy, event.userId);
      } catch (error) {
        // A cache sweep must never cost us the app-specific eviction below.
        onError?.(error, raw);
      }
    }

    if (!onInvalidate) return;
    try {
      const result = onInvalidate(event);
      if (isPromiseLike(result)) {
        Promise.resolve(result).catch((error: unknown) => onError?.(error, raw));
      }
    } catch (error) {
      onError?.(error, raw);
    }
  };
}
