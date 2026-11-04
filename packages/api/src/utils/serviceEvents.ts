/**
 * The service-event feed: how every Oxy backend hears, at once, that a session
 * ended (`@oxy.so/contracts` `sessionRevocation.ts`, consumed by
 * `@oxy.so/core/server`'s `OxyServer`).
 *
 * THREE LEGS
 *
 * 1. PUBLISH. `services/sessionRevocation.service.ts` — the one place a session
 *    is ended — calls {@link publishSessionRevocation} after the write
 *    committed. It goes on {@link SESSION_REVOCATION_CHANNEL} on the shared
 *    Valkey, so every oxy-api task hears it, the publishing one included. The
 *    publish is NOT gated on the client being `ready`: ioredis queues it through
 *    a reconnect rather than dropping it. Without Valkey (a single process,
 *    tests) it is delivered in-process.
 * 2. RELAY. Every task subscribes ({@link startServiceEvents}) and, for each
 *    revocation, drops the session from its own in-memory `sessionCache` tier —
 *    which no other invalidation reaches, so before this a revoked session kept
 *    validating on the other tasks for up to five minutes — and emits it to the
 *    service sockets connected to THIS task (`namespace.local`: every task
 *    relays to its own sockets, so nothing is delivered twice).
 * 3. DELIVER. The `/service-events` namespace admits only live first-party workloads. It revalidates before every delivery
 *    and heartbeat and closes each socket when its token expires.
 *
 * LIVENESS. A consumer caches only while it sees heartbeats, so a task sends one
 * only while it can still hear revocations: every
 * `OXY_SERVICE_EVENTS_HEARTBEAT_MS` it publishes a probe on
 * {@link SERVICE_EVENTS_PROBE_CHANNEL} and vouches for its sockets only while
 * its own probe came back recently. Valkey delivers a subscriber's messages in
 * order, so a returned probe proves every revocation published before it
 * arrived. A subscriber that loses its connection disconnects every local
 * service socket at once, rather than letting them run out the stale window.
 */
import { randomUUID } from 'node:crypto';
import {
  OXY_SERVICE_EVENTS_FORBIDDEN,
  OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
  OXY_SERVICE_EVENTS_HEARTBEAT_MS,
  OXY_SESSION_REVOKED_EVENT,
  oxySessionRevocationEventSchema,
  type OxySessionRevocationEvent,
} from '@oxy.so/contracts';
import type Redis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { getRedisClient } from '../config/redis';
import { verifyServiceToken } from '../middleware/serviceToken';
import { resolveLiveServiceTokenAuthority } from '../services/liveServiceTokenAuthority.service';
import { logger } from './logger';
import sessionCache from './sessionCache';

/** Valkey channel between oxy-api tasks; internal to oxy-api. */
export const SESSION_REVOCATION_CHANNEL = 'oxy-api:session:revoked';
/** Each task's loopback probe, proving its own subscription still delivers. */
export const SERVICE_EVENTS_PROBE_CHANNEL = 'oxy-api:service-events:probe';
/** A probe older than this and the task stops vouching for its sockets. */
const PROBE_FRESH_MS = 2 * OXY_SERVICE_EVENTS_HEARTBEAT_MS + 1_000;

const LOG_COMPONENT = 'ServiceEvents';

/** The namespace this task relays to; `null` outside the API server (scripts, workers). */
let serviceNamespace: Namespace | null = null;

/**
 * Announce a session revocation to every oxy-api task and every connected
 * service. Called only by `services/sessionRevocation.service.ts`. Never throws.
 */
export function publishSessionRevocation(event: OxySessionRevocationEvent): void {
  try {
    const redis = getRedisClient();
    if (!redis) {
      deliver(event);
      return;
    }
    redis.publish(SESSION_REVOCATION_CHANNEL, JSON.stringify(event)).catch((error: unknown) => {
      // Valkey is unreachable, so so is every subscriber: their heartbeats have
      // stopped and no consumer is caching. Deliver to our own sockets anyway.
      logPublishFailure(error);
      deliver(event);
    });
  } catch (error) {
    // The write it announces already committed; never turn that into a failure.
    logPublishFailure(error);
  }
}

function logPublishFailure(error: unknown): void {
  logger.error('serviceEvents: revocation publish failed', {
    component: LOG_COMPONENT,
    err: error instanceof Error ? error.message : String(error),
  });
}

/** Apply a revocation on this task: its session cache tier, then its service sockets. */
function deliver(
  event: OxySessionRevocationEvent,
  namespace: Namespace | null = serviceNamespace,
): void {
  try {
    if (event.sessionId) sessionCache.invalidateLocal(event.sessionId);
    else sessionCache.invalidateUserSessionsLocal(event.userId);
  } finally {
    if (namespace) void emitToLiveServices(namespace, OXY_SESSION_REVOKED_EVENT, event);
  }
}

/**
 * Admit a live first-party workload, including the finite legacy cohort, from
 * `handshake.auth.token`. A refusal that can never succeed answers
 * `OXY_SERVICE_EVENTS_FORBIDDEN`, so the SDK stops asking often.
 */
export async function authorizeServiceSocket(
  socket: Socket,
): Promise<{ ok: true; exp: number; appId: string } | { ok: false; reason: string }> {
  const raw: unknown = socket.handshake.auth?.token;
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'unauthorized' };
  const verification = verifyServiceToken(raw);
  if (!verification.ok) {
    return {
      ok: false,
      reason: verification.reason === 'not_service' ? OXY_SERVICE_EVENTS_FORBIDDEN : 'unauthorized',
    };
  }
  const { payload } = verification;
  if (typeof payload.exp !== 'number') {
    return { ok: false, reason: OXY_SERVICE_EVENTS_FORBIDDEN };
  }
  try {
    const live = await resolveLiveServiceTokenAuthority(payload);
    if (!live || payload.authority !== 'first_party') {
      return { ok: false, reason: OXY_SERVICE_EVENTS_FORBIDDEN };
    }
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, exp: payload.exp, appId: payload.appId };
}

const deliveryQueues = new WeakMap<Namespace, Promise<void>>();

/** Preserve pub/sub order: a heartbeat must never overtake a pending revocation. */
function emitToLiveServices(
  namespace: Namespace,
  event: string,
  value: unknown,
  canEmit: () => boolean = () => true,
): Promise<void> {
  const pending = (deliveryQueues.get(namespace) ?? Promise.resolve())
    .then(() => emitToValidatedServices(namespace, event, value, canEmit))
    .catch(() => namespace.local.disconnectSockets(true));
  deliveryQueues.set(namespace, pending);
  return pending;
}

/** Revoke access before emitting data; heartbeat checks also close idle revoked sockets. */
async function emitToValidatedServices(
  namespace: Namespace,
  event: string,
  value: unknown,
  canEmit: () => boolean = () => true,
): Promise<void> {
  await Promise.all(
    [...namespace.sockets.values()].map(async (socket) => {
      try {
        if (!(await authorizeServiceSocket(socket)).ok) socket.disconnect(true);
      } catch {
        socket.disconnect(true);
      }
    }),
  );
  if (canEmit()) namespace.local.emit(event, value);
}

/**
 * Serve `/service-events` on this task and relay revocations to it. Pass the
 * shared Valkey client, or `null` to run single-process.
 */
export function startServiceEvents(
  namespace: Namespace,
  redis: Redis | null,
): { stop: () => Promise<void> } {
  serviceNamespace = namespace;
  let lastProbe = 0;
  const healthy = () => redis === null || Date.now() - lastProbe <= PROBE_FRESH_MS;
  const heartbeat = () => ({ at: Date.now() });

  namespace.use((socket, next) => {
    authorizeServiceSocket(socket).then(
      (result) => {
        if (!result.ok) {
          next(new Error(result.reason));
          return;
        }
        socket.data.serviceTokenExp = result.exp;
        next();
      },
      () => next(new Error('unavailable')),
    );
  });

  namespace.on('connection', (socket) => {
    // The token admitted this socket; it does not outlive it. The SDK
    // reconnects with a fresh one.
    const expiresIn = Math.max(0, (socket.data.serviceTokenExp as number) * 1000 - Date.now());
    const expiry = setTimeout(() => socket.disconnect(true), expiresIn);
    expiry.unref?.();
    socket.on('disconnect', () => clearTimeout(expiry));
    if (healthy()) socket.emit(OXY_SERVICE_EVENTS_HEARTBEAT_EVENT, heartbeat());
  });

  let subscriber: Redis | null = null;
  const nonce = randomUUID();
  if (redis) {
    subscriber = redis.duplicate();
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel === SERVICE_EVENTS_PROBE_CHANNEL) {
        if (raw !== nonce) return;
        const wasHealthy = healthy();
        lastProbe = Date.now();
        if (!wasHealthy)
          void emitToLiveServices(
            namespace,
            OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
            heartbeat(),
            healthy,
          );
        return;
      }
      if (channel !== SESSION_REVOCATION_CHANNEL) return;
      let event: OxySessionRevocationEvent;
      try {
        const parsed = oxySessionRevocationEventSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw parsed.error;
        event = parsed.data;
      } catch (error) {
        logger.warn('serviceEvents: dropped an unreadable revocation', {
          component: LOG_COMPONENT,
          err: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      try {
        deliver(event, namespace);
      } catch (error) {
        logger.warn('serviceEvents: failed to apply a revocation locally', {
          component: LOG_COMPONENT,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    });
    // Lost subscription: messages published meanwhile are gone for good, so the
    // consumers relying on this task must stop trusting their caches now.
    subscriber.on('close', () => {
      lastProbe = 0;
      namespace.local.disconnectSockets(true);
    });
    subscriber
      .subscribe(SESSION_REVOCATION_CHANNEL, SERVICE_EVENTS_PROBE_CHANNEL)
      .catch((error) => {
        logger.error('serviceEvents: failed to subscribe', {
          component: LOG_COMPONENT,
          err: error instanceof Error ? error.message : String(error),
        });
      });
  }

  const ticker = setInterval(() => {
    if (redis) redis.publish(SERVICE_EVENTS_PROBE_CHANNEL, nonce).catch(() => {});
    if (healthy())
      void emitToLiveServices(namespace, OXY_SERVICE_EVENTS_HEARTBEAT_EVENT, heartbeat(), healthy);
  }, OXY_SERVICE_EVENTS_HEARTBEAT_MS);
  ticker.unref?.();
  if (redis) redis.publish(SERVICE_EVENTS_PROBE_CHANNEL, nonce).catch(() => {});

  return {
    async stop() {
      clearInterval(ticker);
      namespace.local.disconnectSockets(true);
      if (serviceNamespace === namespace) serviceNamespace = null;
      if (!subscriber) return;
      try {
        await subscriber.quit();
      } catch {
        subscriber.disconnect();
      }
    },
  };
}
