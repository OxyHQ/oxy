/**
 * `/models` charges an application credential to its OWN bucket, never to the
 * address it egressed through.
 *
 * Every Oxy service in the cluster leaves through one NAT address. With the
 * catalogue's 600-per-address budget that address was the whole estate's
 * budget, and Alia's deploy readiness gate — one `GET /models/routing-profiles`
 * — was refused 429 by traffic that was not its own.
 *
 * The real `express-rate-limit` runs here (in memory, no Redis); only its budget
 * is shrunk to two, so exhausting a bucket takes three requests instead of six
 * hundred. The keys and skips are the router's own. Credential resolution is
 * stubbed because the audience it produces is covered by
 * `inferenceCatalogueRoute.test.ts`; what this suite owns is which BUCKET a
 * request lands in, and that the key exists before the limiter reads it.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_BUDGET = 2;

jest.mock('../../middleware/rateLimiter', () => {
  const actual = jest.requireActual('../../middleware/rateLimiter');
  return {
    rateLimit: (options: Record<string, unknown>) => actual.rateLimit({ ...options, max: 2 }),
  };
});

jest.mock('../../config/redis', () => ({ getRedisClient: () => null }));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../config/rolloutFlags', () => ({
  isCataloguePublished: () => true,
  isMachineCredentialLaneEnabled: () => true,
}));

jest.mock('../../config/postgres', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: async () => [] }) }),
  }),
}));

jest.mock('../../utils/machineCredentialToken', () => ({
  machineCredentialTokenPrefix: (token: string) =>
    token.startsWith('oxy_sk_') ? token.slice(0, 16) : null,
}));

/**
 * `oxy_sk_<app>_<credential>` is a live machine credential; anything naming
 * `revoked` is not. Parsed rather than tabled so every test owns its own
 * credentials, and therefore its own buckets, in the one module instance.
 */
jest.mock('../../middleware/machineCredential', () => ({
  resolveMachineCredential: async (token: string) => {
    const [, , applicationId, credentialId] = token.split('_');
    return token.includes('revoked') || !applicationId || !credentialId
      ? { ok: false, reason: 'unknown_credential' }
      : { ok: true, principal: { applicationId, credentialId } };
  },
}));

/** `jwt:<app>:<credential>` is a signed service token — how Alia's process credential arrives. */
jest.mock('../../middleware/serviceToken', () => ({
  verifyServiceToken: (token: string) => {
    const [kind, appId, credentialId] = token.split(':');
    return kind === 'jwt' && appId && credentialId
      ? { ok: true, payload: { appId, credentialId } }
      : { ok: false, reason: 'invalid' };
  },
}));

jest.mock('../../services/attribution.service', () => ({
  resolveServiceTokenPrincipal: async (payload: { appId: string; credentialId: string }) => ({
    status: 'resolved',
    principal: { applicationId: payload.appId, credentialId: payload.credentialId },
  }),
}));

jest.mock('../../services/inferenceCatalogue.service', () => {
  const viewer = { audience: 'public' };
  return {
    PUBLIC_CATALOGUE_VIEWER: viewer,
    resolveCatalogueViewer: () => viewer,
    isPublicCatalogueViewer: () => true,
    listRoutingProfiles: async () => [],
    listCatalogueForViewer: async () => [],
    getCatalogueEntryForViewer: async () => undefined,
  };
});

import { errorHandler } from '../../middleware/errorHandler';
import catalogueRouter, {
  CATALOGUE_SERVICE_READS_PER_15_MINUTES,
  catalogueServiceRateLimitKey,
} from '../inferenceCatalogue';

let server: http.Server;

/**
 * Every test egresses from its own address and presents its own credentials,
 * because the limiters' in-memory stores live for the whole module. `trust
 * proxy` is what lets a forwarded address stand in for a NAT egress here.
 */
function get(address: string, token?: string): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/models/routing-profiles',
        method: 'GET',
        headers: {
          'X-Forwarded-For': address,
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function exhaust(address: string, token?: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i <= TEST_BUDGET; i += 1) statuses.push(await get(address, token));
  return statuses;
}

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use('/models', catalogueRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('catalogue rate-limit partitioning', () => {
  it('keeps anonymous readers on the per-address budget', async () => {
    expect(await exhaust('203.0.113.1')).toEqual([200, 200, 429]);
  });

  it('does not charge a service credential to its exhausted egress address', async () => {
    const nat = '203.0.113.2';
    await exhaust(nat);
    // Same address, anonymous budget spent: both credential lanes are still served.
    expect(await get(nat, 'oxy_sk_alia_credA')).toBe(200);
    expect(await get(nat, 'jwt:alia:credS')).toBe(200);
    // And an anonymous reader is still refused — the skip did not reopen the address bucket.
    expect(await get(nat)).toBe(429);
  });

  it('gives two credentials behind one address two buckets, and leaves the address bucket untouched', async () => {
    const nat = '203.0.113.3';
    expect(await exhaust(nat, 'oxy_sk_alia_credC')).toEqual([200, 200, 429]);
    expect(await get(nat, 'oxy_sk_alia_credD')).toBe(200);
    expect(await exhaust(nat, 'jwt:mention:credM')).toEqual([200, 200, 429]);
    expect(await get(nat, 'jwt:alia:credN')).toBe(200);
    expect(await exhaust(nat)).toEqual([200, 200, 429]);
  });

  it('keeps an unresolvable bearer on the address budget, so a junk token buys no bucket', async () => {
    const nat = '203.0.113.4';
    expect(await get(nat, 'oxy_sk_alia_revoked')).toBe(200);
    expect(await get(nat, 'not-a-token')).toBe(200);
    expect(await get(nat)).toBe(429);
  });
});

describe('catalogueServiceRateLimitKey', () => {
  it('keys on the exact application and credential', () => {
    const requestFor = (applicationId: string, credentialId: string) =>
      ({ catalogueCaller: { applicationId, credentialId } }) as unknown as Parameters<
        typeof catalogueServiceRateLimitKey
      >[0];

    expect(catalogueServiceRateLimitKey(requestFor('app-a', 'cred-a'))).toBe('app-a:cred-a');
    expect(catalogueServiceRateLimitKey(requestFor('app-a', 'cred-b'))).not.toBe(
      catalogueServiceRateLimitKey(requestFor('app-a', 'cred-a'))
    );
    expect(catalogueServiceRateLimitKey(requestFor('app-b', 'cred-a'))).not.toBe(
      catalogueServiceRateLimitKey(requestFor('app-a', 'cred-a'))
    );
    expect(CATALOGUE_SERVICE_READS_PER_15_MINUTES).toBeGreaterThan(600);
  });
});
