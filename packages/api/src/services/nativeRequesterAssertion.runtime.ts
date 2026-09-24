/**
 * Production wiring for `nativeRequesterAssertion.service.ts` (ADR 0025).
 *
 * Kept apart from the service so its authority logic is tested against explicit
 * fakes, and so this file holds only the mapping from real platform state
 * (sessions, applications, credentials, Redis, the capability-ticket key) onto
 * the narrow questions that logic asks.
 */

import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { resolveLiveAgencyCoordinator, resolveLiveAgencyWorkload } from './agencyServicePrincipal.service';
import sessionService from './session.service';
import type {
  ReplayStoreResult,
  RequesterAssertionDependencies,
  RequesterAssertionRecord,
  RequesterAssertionStore,
} from './nativeRequesterAssertion.service';

const KEY_PREFIX = 'native-requester-assertion:';

function isRecord(value: unknown): value is RequesterAssertionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['sessionId', 'requesterAccountId', 'applicationId', 'credentialId', 'agentId']
    .every((key) => typeof record[key] === 'string' && (record[key] as string).length > 0);
}

/**
 * Process-local store, for development and tests only. It cannot enforce
 * single use across tasks, which is why production never falls back to it.
 */
export function createMemoryRequesterAssertionStore(now: () => number = Date.now): RequesterAssertionStore {
  const entries = new Map<string, { record: RequesterAssertionRecord; expiresAt: number }>();
  return {
    async put(jti, record, ttlSeconds) {
      const current = entries.get(jti);
      if (current && current.expiresAt > now()) return { status: 'ok', value: false };
      entries.set(jti, { record, expiresAt: now() + ttlSeconds * 1000 });
      return { status: 'ok', value: true };
    },
    async take(jti) {
      const current = entries.get(jti);
      entries.delete(jti);
      if (!current || current.expiresAt <= now()) return { status: 'ok', value: null };
      return { status: 'ok', value: current.record };
    },
  };
}

function createRedisRequesterAssertionStore(): RequesterAssertionStore {
  const unavailable = { status: 'unavailable' } as const;
  const client = () => {
    const redis = getRedisClient();
    return redis && redis.status === 'ready' ? redis : null;
  };
  return {
    async put(jti, record, ttlSeconds): Promise<ReplayStoreResult<boolean>> {
      const redis = client();
      if (!redis) return unavailable;
      try {
        const result = await redis.set(`${KEY_PREFIX}${jti}`, JSON.stringify(record), 'EX', ttlSeconds, 'NX');
        return { status: 'ok', value: result === 'OK' };
      } catch (error) {
        logger.warn('[requester-assertion] replay store write failed', { error: String(error) });
        return unavailable;
      }
    },
    async take(jti): Promise<ReplayStoreResult<RequesterAssertionRecord | null>> {
      const redis = client();
      if (!redis) return unavailable;
      try {
        // GETDEL is the single-use property: read and delete are one command,
        // so two tasks introspecting the same jti cannot both see the record.
        const raw = await redis.getdel(`${KEY_PREFIX}${jti}`);
        if (raw === null) return { status: 'ok', value: null };
        const parsed = JSON.parse(raw) as unknown;
        return { status: 'ok', value: isRecord(parsed) ? parsed : null };
      } catch (error) {
        logger.warn('[requester-assertion] replay store read failed', { error: String(error) });
        return unavailable;
      }
    },
  };
}

let memoryStore: RequesterAssertionStore | undefined;

function requesterAssertionStore(): RequesterAssertionStore {
  if (process.env.REDIS_URL) return createRedisRequesterAssertionStore();
  if (process.env.NODE_ENV === 'production') {
    return {
      async put() { return { status: 'unavailable' }; },
      async take() { return { status: 'unavailable' }; },
    };
  }
  memoryStore ??= createMemoryRequesterAssertionStore();
  return memoryStore;
}

export function requesterAssertionRuntime(): RequesterAssertionDependencies {
  return {
    issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    now: () => new Date(),
    signing: () => {
      const config = capabilityTicketSigningConfig();
      return { keyId: config.keyId, privateKey: config.privateKey, publicKey: config.publicKey };
    },
    resolvePrincipal: async (applicationId, credentialId) => {
      const principal = await resolveLiveAgencyCoordinator(applicationId, credentialId);
      return principal
        ? { applicationId: principal.applicationId, credentialId: principal.credentialId, scopes: principal.scopes }
        : null;
    },
    resolveWorkloadPrincipal: async (applicationId, provider, subject) => {
      const principal = await resolveLiveAgencyWorkload(applicationId, provider, subject);
      return principal
        ? { applicationId: principal.applicationId, handle: principal.handle, scopes: principal.scopes }
        : null;
    },
    validateSubjectToken: async (token) => {
      const result = await sessionService.validateSession(token);
      if (!result?.token) return null;
      return {
        sessionId: result.token.sessionId,
        subjectAccountId: result.token.subjectAccountId,
        applicationId: result.token.applicationId,
        accountStatus: result.user.accountStatus,
      };
    },
    loadLiveSession: async (sessionId) => {
      const result = await sessionService.validateSessionById(sessionId, true, { useCache: false });
      if (!result?.user) return null;
      return {
        sessionId: result.session.sessionId,
        accountId: result.session.userId,
        applicationId: result.session.applicationId ?? null,
        accountStatus: result.user.accountStatus,
      };
    },
    store: requesterAssertionStore(),
  };
}
