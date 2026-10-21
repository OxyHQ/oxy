/**
 * Canonical contract for the session-revocation feed: oxy-api telling every
 * connected Oxy backend that a session stopped being valid.
 *
 * WHY IT EXISTS. `@oxy.so/core/server` reuses a successful bearer validation on
 * a backend for a short TTL, because an app backend cannot verify a user access
 * token itself (HS256 under a secret only oxy-api holds) and asking Oxy on every
 * request put ~300 ms on every authenticated route. A cache like that is only
 * safe if it hears about revocations the moment they happen. This feed is how it
 * hears: oxy-api announces every session it ends — logout, sign-out-all, device
 * removal, an account switched away from, an admin or operator revocation, a
 * credential change that ends sessions, account deletion or archive — and the
 * SDK drops what it cached for that session or user.
 *
 * THE TRANSPORT IS THE SDK's. A backend opens no Redis client and wires nothing:
 * `OxyServer` connects to the {@link OXY_SERVICE_EVENTS_NAMESPACE} Socket.IO
 * namespace on oxy-api with its own service token, and uses its validation cache
 * ONLY while that connection is live (connected, and a
 * {@link OXY_SERVICE_EVENTS_HEARTBEAT_EVENT} seen within
 * {@link OXY_SERVICE_EVENTS_STALE_AFTER_MS}). Disconnected, stale or never
 * connected, it validates every request against Oxy. So a lost connection costs
 * latency, never correctness.
 *
 * DELIVERY. A revocation is announced after the write that ended the session
 * committed. Between oxy-api tasks it rides Valkey pub/sub, which is
 * at-most-once; the heartbeat is what makes a silent loss of the path visible —
 * a task emits it only while its own Valkey round trip works — so a consumer
 * stops trusting its cache when the path stops working, instead of trusting it
 * forever.
 *
 * PRIVACY — the payload carries ids and a timestamp only. Only Oxy's own
 * (internal-tier) services may join the namespace, and even so nothing a
 * consumer could render is ever placed on it.
 *
 * Platform-agnostic — zod only, no react/react-native/expo.
 */

import { z } from 'zod';

/** The Socket.IO namespace on oxy-api that carries service events. */
export const OXY_SERVICE_EVENTS_NAMESPACE = '/service-events';

/** One session (or every session of one user) stopped being valid. */
export const OXY_SESSION_REVOKED_EVENT = 'session:revoked';

/**
 * Emitted on connect and then every {@link OXY_SERVICE_EVENTS_HEARTBEAT_MS}
 * while the emitting oxy-api task can still hear revocations (its Valkey
 * subscription round-trips). Carries `{ at }`, the task's epoch-ms clock.
 */
export const OXY_SERVICE_EVENTS_HEARTBEAT_EVENT = 'heartbeat';

/** How often a live oxy-api task sends {@link OXY_SERVICE_EVENTS_HEARTBEAT_EVENT}. */
export const OXY_SERVICE_EVENTS_HEARTBEAT_MS = 5_000;

/**
 * How long a consumer keeps trusting the feed after the last heartbeat. Past
 * this the feed counts as down: every cached validation is dropped and nothing
 * is cached until heartbeats resume.
 */
export const OXY_SERVICE_EVENTS_STALE_AFTER_MS = 12_000;

/**
 * The `connect_error` message oxy-api answers a caller that may never join the
 * namespace (not a service token, or not an internal-tier application). A
 * consumer stops retrying quickly on it; any other refusal is retried.
 */
export const OXY_SERVICE_EVENTS_FORBIDDEN = 'service_events_forbidden';

/**
 * A session revocation.
 *
 * - With `sessionId`: that one session ended. `userId` is the account it spoke
 *   as.
 * - Without `sessionId`: every session of `userId` ended, or may have — the
 *   account was deleted or archived, or signed out everywhere. A consumer drops
 *   everything it holds for that account, including sessions it operated as a
 *   delegate.
 *
 * `at` is the publisher's epoch-ms clock: diagnostic only (propagation delay),
 * never used for ordering — the event says "ask Oxy again", which is idempotent.
 */
export const oxySessionRevocationEventSchema = z.object({
  /** The session that ended; absent for a revocation of every session of `userId`. */
  sessionId: z.string().min(1).max(256).optional(),
  /** The account the session (or sessions) spoke as. */
  userId: z.string().min(1).max(256),
  /** Publisher's epoch-ms timestamp. Diagnostic only. */
  at: z.number().int().nonnegative(),
});

export type OxySessionRevocationEvent = z.infer<typeof oxySessionRevocationEventSchema>;

/** The heartbeat payload. */
export const oxyServiceEventsHeartbeatSchema = z.object({
  at: z.number().int().nonnegative(),
});

export type OxyServiceEventsHeartbeat = z.infer<typeof oxyServiceEventsHeartbeatSchema>;
