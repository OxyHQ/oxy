/**
 * `/federation/sign` + `/federation/public-key` — the sign-on-behalf trust
 * boundary, with the credential → domain allow-list resolved against a REAL
 * Postgres.
 *
 * These endpoints let a service credential (Mention) obtain the public half of,
 * and HTTP-Signature signatures from, a domain-scoped key whose PRIVATE half
 * never leaves Oxy. What stops that from being a signing oracle for the whole
 * internet is `loadAllowedDomains`: an Application has no explicit
 * federation-domain field, so the hosts of its `redirectUris` ARE the set of
 * domains its credentials may operate on.
 *
 * ## The guarantee this file exists for
 *
 * **`loadAllowedDomains` must FAIL CLOSED.** A missing application, a
 * non-`active` one, and one whose redirect URIs parse to nothing must each yield
 * an EMPTY allow-list, and an empty allow-list must deny (403) — never default,
 * never admit. That is a security boundary whose failure mode is silent: an
 * over-wide allow-list signs a request for a domain the credential does not own
 * and nothing errors.
 *
 * The previous suite could not have caught any of it. It replaced
 * `credentialDomainCache` with a stub that returned whatever `Set` the test
 * handed it, so `loadAllowedDomains` — the entire boundary — never ran, and the
 * `models/Application` mock it needed was there only to keep the import from
 * reaching mongoose. Here the cache and the loader are real, the applications
 * are rows, and each fail-closed case is reached by putting the DATABASE into
 * that state rather than by asserting a stub was consulted.
 *
 * ## What is still mocked, and why
 *
 * `serviceAuthMiddleware` (the credential it presents — appId and scopes — is
 * the test PARAMETER) and `federation.service`, which owns the key store and has
 * its own suites; `signWithKeyId` is wired to a REAL RSA private key here so the
 * signature the route returns is verified against the matching public key rather
 * than merely echoed.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

const mockGetUserPublicKey = jest.fn();
const mockSignWithKeyId = jest.fn();

/** The credential `serviceAuthMiddleware` presents — set per test. */
let currentServiceApp: Record<string, unknown> | undefined;

jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (
    req: { serviceApp?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = currentServiceApp;
    next();
  },
}));

jest.mock('../../services/federation.service', () => ({
  __esModule: true,
  getUserPublicKey: (...args: unknown[]) => mockGetUserPublicKey(...args),
  signWithKeyId: (...args: unknown[]) => mockSignWithKeyId(...args),
}));

jest.mock('../../services/securityActivityService', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { APPLICATION_STATUSES, applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import credentialDomainCache from '../../utils/credentialDomainCache';
import federationRouter from '../federation';

type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

interface JsonResponse {
  status: number;
  body: {
    error?: string;
    message?: string;
    details?: Record<string, unknown>;
    data?: Record<string, unknown>;
  };
}

async function requestJson(
  method: string,
  path: string,
  payload?: unknown,
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const hasBody = method !== 'GET';
  const body = hasBody ? JSON.stringify(payload ?? {}) : '';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: hasBody
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (hasBody) req.write(body);
    req.end();
  });
}

const MENTION_DOMAIN = 'mention.earth';
const MENTION_KEY_ID = `https://${MENTION_DOMAIN}/ap/users/bob#main-key`;
const SIGNING_STRING = [
  '(request-target): post /ap/users/alice/inbox',
  'host: mastodon.social',
  'date: Wed, 18 Jun 2026 00:00:00 GMT',
].join('\n');

let server: http.Server;
let publicKeyPem: string;
let privateKeyPem: string;
let ownerAccountId: string;

/**
 * A registered application whose redirect URIs are the ONLY source of its
 * federation authority — the derivation this suite exists to hold.
 */
async function seedApplication(
  redirectUris: string[],
  status: ApplicationStatus = 'active',
): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: 'Mention', ownerAccountId, redirectUris, status })
    .returning({ id: applications.id });
  return row.id;
}

/** Present a credential belonging to `appId`, carrying `federation:write`. */
function presentCredential(appId: string | undefined, scopes = ['federation:write']): void {
  currentServiceApp = {
    type: 'service',
    appId,
    appName: 'Mention',
    credentialId: 'cred-1',
    scopes,
  };
}

beforeAll(async () => {
  await connectPostgres();

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = publicKey;
  privateKeyPem = privateKey;

  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  ownerAccountId = owner.id;

  const app = express();
  app.use(express.json());
  app.use('/federation', federationRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  // The cache memoizes per appId for 60s. Clearing it means each case reaches
  // the loader, so a case that puts the DATABASE into a deny state is actually
  // testing the loader rather than an entry left behind by an earlier one.
  credentialDomainCache.clear();

  presentCredential(await seedApplication([`https://${MENTION_DOMAIN}/oauth/callback`]));

  // Signing produces a REAL signature with the test private key, so a verifier
  // holding the matching public key accepts it.
  mockSignWithKeyId.mockImplementation((_keyId: string, signingString: string) => {
    const signer = crypto.createSign('sha256');
    signer.update(signingString);
    signer.end();
    return Promise.resolve(signer.sign(privateKeyPem, 'base64'));
  });
  mockGetUserPublicKey.mockResolvedValue({ keyId: MENTION_KEY_ID, publicKeyPem });
});

describe('loadAllowedDomains — the allow-list must FAIL CLOSED', () => {
  it.each<ApplicationStatus>(['suspended', 'deleted', 'pending_review'])(
    'denies a credential whose application is %s, even though its redirectUris name the host',
    async (status) => {
      presentCredential(await seedApplication([`https://${MENTION_DOMAIN}/oauth/callback`], status));

      const res = await requestJson('POST', '/federation/sign', {
        keyId: MENTION_KEY_ID,
        signingString: SIGNING_STRING,
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'FORBIDDEN',
        message: 'keyId host is not authorised for this application',
      });
      expect(mockSignWithKeyId).not.toHaveBeenCalled();
    },
  );

  it('denies a credential whose application id names no row', async () => {
    const appId = await seedApplication([`https://${MENTION_DOMAIN}/oauth/callback`]);
    await getDb().delete(applications).where(eq(applications.id, appId));
    presentCredential(appId);

    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(403);
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('denies an active application with no redirectUris at all', async () => {
    presentCredential(await seedApplication([]));

    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(403);
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('denies an active application whose redirectUris parse to no usable host', async () => {
    // A scheme-relative string, a bare path, an empty string and a scheme with
    // no authority: `new URL` either throws or yields an empty hostname, and
    // neither can ever equal a requested bare hostname.
    presentCredential(
      await seedApplication(['', '/oauth/callback', 'not a url', 'javascript:alert(1)']),
    );

    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(403);
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('denies a credential that carries no application id', async () => {
    presentCredential(undefined);

    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(403);
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it("never lends one application's redirectUris to another's credential", async () => {
    const mention = await seedApplication([`https://${MENTION_DOMAIN}/oauth/callback`]);
    const other = await seedApplication(['https://evil.example/oauth/callback']);

    // Warm the cache for the application that IS authorised for mention.earth…
    presentCredential(mention);
    expect(
      (await requestJson('POST', '/federation/sign', {
        keyId: MENTION_KEY_ID,
        signingString: SIGNING_STRING,
      })).status,
    ).toBe(200);

    // …then ask with the other application's credential. Its own allow-list is
    // the only one that may answer.
    presentCredential(other);
    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(403);
    expect(mockSignWithKeyId).toHaveBeenCalledTimes(1);
  });
});

describe('loadAllowedDomains — what an active application DOES authorise', () => {
  it('authorises the host of every registered redirect URI', async () => {
    presentCredential(
      await seedApplication([
        'https://staging.mention.earth/oauth/callback',
        `https://${MENTION_DOMAIN}/oauth/callback`,
      ]),
    );

    const first = await requestJson(
      'GET',
      `/federation/public-key/bob?domain=staging.${MENTION_DOMAIN}`,
    );
    const second = await requestJson('GET', `/federation/public-key/bob?domain=${MENTION_DOMAIN}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('authorises the HOST, not the origin — a port and a path do not narrow it', async () => {
    presentCredential(await seedApplication([`https://${MENTION_DOMAIN}:8443/deep/callback?x=1`]));

    const res = await requestJson('GET', `/federation/public-key/bob?domain=${MENTION_DOMAIN}`);

    expect(res.status).toBe(200);
  });

  it('matches the host case-insensitively', async () => {
    presentCredential(await seedApplication(['https://Mention.EARTH/oauth/callback']));

    const res = await requestJson('GET', `/federation/public-key/bob?domain=${MENTION_DOMAIN}`);

    expect(res.status).toBe(200);
  });

  it('does not authorise a subdomain of a registered host', async () => {
    // The allow-list is a set of exact hostnames, not a suffix rule.
    presentCredential(await seedApplication([`https://${MENTION_DOMAIN}/oauth/callback`]));

    const res = await requestJson(
      'GET',
      `/federation/public-key/bob?domain=evil.${MENTION_DOMAIN}`,
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'domain is not registered for this application',
    });
    expect(mockGetUserPublicKey).not.toHaveBeenCalled();
  });
});

describe('POST /federation/sign', () => {
  it('happy path: returns a base64 signature that verifies against the public key', async () => {
    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(200);
    expect(res.body.data?.keyId).toBe(MENTION_KEY_ID);
    expect(res.body.data?.algorithm).toBe('rsa-sha256');
    const signature = res.body.data?.signature;
    expect(typeof signature).toBe('string');
    expect(Object.keys(res.body.data ?? {}).sort()).toEqual(['algorithm', 'keyId', 'signature']);

    // Real RSA round-trip: the returned signature must verify under the public key.
    const verifier = crypto.createVerify('sha256');
    verifier.update(SIGNING_STRING);
    verifier.end();
    expect(verifier.verify(publicKeyPem, signature as string, 'base64')).toBe(true);

    // The private key is never disclosed.
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    expect(res.body.data).not.toHaveProperty('privateKeyPem');
  });

  it('rejects when the service token lacks federation:write scope (403)', async () => {
    presentCredential(
      await seedApplication([`https://${MENTION_DOMAIN}/oauth/callback`]),
      [],
    );

    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'Missing required scope: federation:write',
    });
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('rejects a keyId whose host is not a registered domain for the credential (403)', async () => {
    const res = await requestJson('POST', '/federation/sign', {
      keyId: 'https://evil.example/ap/users/bob#main-key',
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'keyId host is not authorised for this application',
    });
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('rejects a non-existent key pair (404)', async () => {
    mockSignWithKeyId.mockResolvedValueOnce(null);

    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'NOT_FOUND',
      message: 'No key pair exists for the requested keyId',
    });
  });

  it('rejects a signingString that does not begin with "(request-target):" (400)', async () => {
    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: 'host: mastodon.social\ndate: Wed, 18 Jun 2026 00:00:00 GMT',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
    expect(res.body.message).toBe('Validation failed');
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('rejects a keyId that does not end with #main-key (400)', async () => {
    const res = await requestJson('POST', '/federation/sign', {
      keyId: `https://${MENTION_DOMAIN}/ap/users/bob`,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(400);
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('rejects an oversized signingString (400)', async () => {
    const huge = `(request-target): post /ap/inbox\n${'x'.repeat(5000)}`;
    const res = await requestJson('POST', '/federation/sign', {
      keyId: MENTION_KEY_ID,
      signingString: huge,
    });

    expect(res.status).toBe(400);
    expect(mockSignWithKeyId).not.toHaveBeenCalled();
  });

  it('accepts a www. keyId host when the credential is registered for the bare domain', async () => {
    const keyId = `https://www.${MENTION_DOMAIN}/ap/users/bob#main-key`;

    const res = await requestJson('POST', '/federation/sign', {
      keyId,
      signingString: SIGNING_STRING,
    });

    expect(res.status).toBe(200);
    expect(mockSignWithKeyId).toHaveBeenCalledWith(keyId, SIGNING_STRING);
  });
});

describe('GET /federation/public-key/:username', () => {
  it('returns { keyId, publicKeyPem } and never privateKeyPem', async () => {
    const res = await requestJson('GET', `/federation/public-key/bob?domain=${MENTION_DOMAIN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { keyId: MENTION_KEY_ID, publicKeyPem } });
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    expect(mockGetUserPublicKey).toHaveBeenCalledWith('bob', MENTION_DOMAIN);
  });

  it('rejects a domain not registered for the credential (403)', async () => {
    const res = await requestJson('GET', '/federation/public-key/bob?domain=evil.example');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'domain is not registered for this application',
    });
    expect(mockGetUserPublicKey).not.toHaveBeenCalled();
  });

  it('rejects a missing federation:write scope (403)', async () => {
    presentCredential(
      await seedApplication([`https://${MENTION_DOMAIN}/oauth/callback`]),
      [],
    );

    const res = await requestJson('GET', `/federation/public-key/bob?domain=${MENTION_DOMAIN}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'FORBIDDEN',
      message: 'Missing required scope: federation:write',
    });
    expect(mockGetUserPublicKey).not.toHaveBeenCalled();
  });

  it('accepts a www. domain query when the credential is registered for the bare domain', async () => {
    const res = await requestJson(
      'GET',
      `/federation/public-key/bob?domain=www.${MENTION_DOMAIN}`,
    );

    expect(res.status).toBe(200);
    expect(mockGetUserPublicKey).toHaveBeenCalledWith('bob', `www.${MENTION_DOMAIN}`);
  });
});
