/**
 * `POST /internal/native-agents/requester-assertions` and its `/introspect`,
 * over real HTTP against a real Postgres, with the REAL service-token
 * middleware, the REAL session service and the REAL runtime wiring (ADR 0025).
 *
 * The service suite proves the authority logic against fakes. This one proves
 * the wiring cannot open the lane the logic keeps shut: the router's trust gate
 * still applies, a real user session is what gets validated, a sign-out is seen
 * through the session cache, the human bearer never comes back out, and a
 * minted assertion is consumable exactly once, by Alia only.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Request } from 'express';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../config/redis', () => ({ getRedisClient: () => null }));

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  ALIA_RESOURCE_SERVER_APPLICATION_ID,
  NATIVE_PRODUCT_AGENTS,
} from '../../config/nativeProductAgents';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import sessionService from '../../services/session.service';
import { workloadAttestationHandle } from '../../services/workloadAttestation.service';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import internalRouter from '../internal';

const ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
const HOMIIO = NATIVE_PRODUCT_AGENTS.products.homiio;
/** The role the Homiio entry point declares, and the handle its tokens carry. */
const HOMIIO_ROLE = 'arn:aws:iam::237343248947:role/oxy-homiio-task';
const HOMIIO_HANDLE = workloadAttestationHandle(HOMIIO_ROLE);
const MENTION_HANDLE = workloadAttestationHandle('arn:aws:iam::237343248947:role/oxy-mention-task');
const SIGNING_KEY = generateKeyPairSync('ed25519');

interface Principal {
  appId: string;
  credentialId: string;
  ownerAccountId: string;
  scopes: string[];
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> & { data?: Record<string, unknown> };
  raw: string;
}

let server: http.Server;
let homiio: Principal;
let alia: Principal;
let untrusted: Principal;
let otherOfficial: Principal;
/** The SAME Homiio application, calling with no key pair at all (ADR 0026). */
let attestedHomiio: Principal;

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}` })
    .returning({ id: users.id });
  return row.id;
}

async function seedPrincipal(input: {
  appId?: string;
  credentialId?: string;
  type: 'internal' | 'first_party' | 'third_party';
  isOfficial?: boolean;
  scopes: string[];
}): Promise<Principal> {
  const ownerAccountId = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({
      ...(input.appId ? { id: input.appId } : {}),
      name: `App ${randomUUID()}`,
      type: input.type,
      isOfficial: input.isOfficial ?? false,
      status: 'active',
      scopes: input.scopes,
      ownerAccountId,
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      ...(input.credentialId ? { id: input.credentialId } : {}),
      applicationId: app.id,
      name: 'service',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
      scopes: input.scopes,
    })
    .returning({ id: applicationCredentials.id });
  return { appId: app.id, credentialId: credential.id, ownerAccountId, scopes: input.scopes };
}

function serviceToken(principal: Principal): string {
  return jwt.sign(
    {
      type: 'service',
      appId: principal.appId,
      appName: 'Test',
      credentialId: principal.credentialId,
      ownerAccountId: principal.ownerAccountId,
      environment: 'production',
      scopes: principal.scopes,
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: 3600, issuer: 'oxy-auth', audience: 'oxy-api' },
  );
}

function post(path: string, token: string | null, body: unknown): Promise<HttpResult> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          connection: 'close',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {}, raw }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function mint(principal: Principal, subjectToken: string, agentId: string = HOMIIO.aliaAgent.id) {
  return post('/internal/native-agents/requester-assertions', serviceToken(principal), { agentId, subjectToken });
}

function introspect(principal: Principal, assertion: string, presenter = { applicationId: HOMIIO.applicationId, credentialId: HOMIIO.sindiServiceCredential.id }) {
  return post('/internal/native-agents/requester-assertions/introspect', serviceToken(principal), { assertion, presenter });
}

function request(): Request {
  return { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as unknown as Request;
}

async function signedInUser(): Promise<{ userId: string; sessionId: string; accessToken: string }> {
  const userId = await account();
  const session = await sessionService.createSession(userId, request(), { deviceId: `dev-${randomUUID()}` });
  return { userId, sessionId: session.sessionId, accessToken: session.accessToken };
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'cap-route-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = SIGNING_KEY.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  await connectPostgres();

  homiio = await seedPrincipal({
    appId: HOMIIO.applicationId,
    credentialId: HOMIIO.sindiServiceCredential.id,
    type: 'first_party',
    isOfficial: true,
    scopes: ['inference:invoke', 'acting-as:offline'],
  });
  alia = await seedPrincipal({ appId: ALIA_RESOURCE_SERVER_APPLICATION_ID, type: 'internal', scopes: ['user:read'] });
  untrusted = await seedPrincipal({ type: 'third_party', scopes: ['inference:invoke'] });
  otherOfficial = await seedPrincipal({ type: 'first_party', isOfficial: true, scopes: ['inference:invoke'] });

  // The binding row is the attested caller's authority: staff wrote it, it
  // names this one role and this one application, and it names its scopes.
  await getDb().insert(applicationWorkloadIdentities).values({
    applicationId: HOMIIO.applicationId,
    provider: 'aws-iam',
    subject: HOMIIO_ROLE,
    description: 'Homiio ECS task role',
    scopes: ['inference:invoke', 'acting-as:offline'],
  });
  attestedHomiio = { ...homiio, credentialId: HOMIIO_HANDLE };

  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  sessionCache.clear();
  userCache.clear();
});

describe('present-requester assertion routes', () => {
  it('mints for a signed-in person with no grant, and Alia consumes it exactly once', async () => {
    const person = await signedInUser();
    const minted = await mint(homiio, person.accessToken);
    expect(minted.status).toBe(201);
    expect(minted.body.data).toMatchObject({ requesterAccountId: person.userId, agentId: HOMIIO.aliaAgent.id });
    expect(minted.raw).not.toContain(person.accessToken);
    expect(minted.raw).not.toContain(person.sessionId);

    const assertion = String(minted.body.data?.assertion);
    const first = await introspect(alia, assertion);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      active: true,
      requesterAccountId: person.userId,
      agentId: HOMIIO.aliaAgent.id,
      applicationId: HOMIIO.applicationId,
      credentialId: HOMIIO.sindiServiceCredential.id,
    });

    const replay = await introspect(alia, assertion);
    expect(replay.body.data).toEqual({ active: false });
  });

  /**
   * The same product, the same person, the same agent — with the key pair gone
   * from Homiio's task definition. Real HTTP, the real service-token
   * middleware, a real binding row and the real runtime: the wiring has to
   * resolve the `wl_…` the token carries to that row, or every Sindi chat turn
   * answers a signed-in person with "sign in".
   */
  it('mints for an ATTESTED Homiio backend, and Alia consumes it under the handle', async () => {
    const person = await signedInUser();
    const minted = await mint(attestedHomiio, person.accessToken);
    expect(minted.status).toBe(201);
    expect(minted.body.data).toMatchObject({ requesterAccountId: person.userId, agentId: HOMIIO.aliaAgent.id });

    const assertion = String(minted.body.data?.assertion);
    const consumed = await introspect(alia, assertion, {
      applicationId: HOMIIO.applicationId,
      credentialId: HOMIIO_HANDLE,
    });
    expect(consumed.body.data).toMatchObject({
      active: true,
      requesterAccountId: person.userId,
      agentId: HOMIIO.aliaAgent.id,
      applicationId: HOMIIO.applicationId,
      // What called, not the credential that did not.
      credentialId: HOMIIO_HANDLE,
    });
  });

  /**
   * A `wl_` prefix authorises nothing. `wl_d61be5…` is Mention's REAL handle,
   * and a token carrying it is one a compromised Mention task genuinely holds.
   */
  it('refuses an attested caller from another role, even on the Homiio application', async () => {
    const person = await signedInUser();
    const res = await mint({ ...homiio, credentialId: MENTION_HANDLE }, person.accessToken);
    expect(res.status).toBe(403);
  });

  /**
   * The binding is the live ceiling, and it is checked on the same grounds a
   * dead credential is — the row is deleted here and put back, because every
   * other case in this file depends on it.
   */
  it('refuses an attested caller whose binding was revoked', async () => {
    const person = await signedInUser();
    await getDb().delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, HOMIIO_ROLE));
    try {
      expect((await mint(attestedHomiio, person.accessToken)).status).toBe(403);
    } finally {
      await getDb().insert(applicationWorkloadIdentities).values({
        applicationId: HOMIIO.applicationId,
        provider: 'aws-iam',
        subject: HOMIIO_ROLE,
        description: 'Homiio ECS task role',
        scopes: ['inference:invoke', 'acting-as:offline'],
      });
    }
    expect((await mint(attestedHomiio, person.accessToken)).status).toBe(201);
  });

  /** The credential path is untouched: the two proofs are not interchangeable. */
  it('refuses an attested assertion presented under the credential id', async () => {
    const person = await signedInUser();
    const minted = await mint(attestedHomiio, person.accessToken);
    expect(minted.status).toBe(201);
    const inactive = await introspect(alia, String(minted.body.data?.assertion));
    expect(inactive.body.data).toEqual({ active: false });
  });

  it('refuses a request with no service token', async () => {
    const person = await signedInUser();
    const res = await post('/internal/native-agents/requester-assertions', null, { agentId: HOMIIO.aliaAgent.id, subjectToken: person.accessToken });
    expect(res.status).toBe(401);
  });

  it('refuses a person\'s own bearer in place of a service token', async () => {
    const person = await signedInUser();
    const res = await post('/internal/native-agents/requester-assertions', person.accessToken, { agentId: HOMIIO.aliaAgent.id, subjectToken: person.accessToken });
    expect([401, 403]).toContain(res.status);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a non-official application at the router gate', async () => {
    const person = await signedInUser();
    const res = await mint(untrusted, person.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses an official application that is not a pinned entry point, with one opaque answer', async () => {
    const person = await signedInUser();
    for (const principal of [otherOfficial, alia]) {
      const res = await mint(principal, person.accessToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REQUESTER_ASSERTION_REFUSED');
    }
  });

  it('refuses a forged bearer, a service token as subject and the wrong agent with the same answer', async () => {
    const person = await signedInUser();
    const forged = jwt.sign({ userId: person.userId, sessionId: person.sessionId }, 'not-the-secret');
    for (const res of [
      await mint(homiio, forged),
      await mint(homiio, serviceToken(homiio)),
      await mint(homiio, person.accessToken, NATIVE_PRODUCT_AGENTS.products.clarity.aliaAgent.id),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REQUESTER_ASSERTION_REFUSED');
      expect(res.raw).not.toContain(person.accessToken);
    }
  });

  it('refuses to mint for, and to honour an assertion of, a person who has signed out', async () => {
    const person = await signedInUser();
    const minted = await mint(homiio, person.accessToken);
    expect(minted.status).toBe(201);

    // The session is still warm in this task's cache when the person signs out.
    await sessionService.validateSession(person.accessToken);
    await sessionService.deactivateSession(person.sessionId);

    const introspected = await introspect(alia, String(minted.body.data?.assertion));
    expect(introspected.body.data).toEqual({ active: false });
    expect((await mint(homiio, person.accessToken)).status).toBe(403);
  });

  it('lets only Alia consume, and a refused consumer does not spend the assertion', async () => {
    const person = await signedInUser();
    const minted = await mint(homiio, person.accessToken);
    const assertion = String(minted.body.data?.assertion);
    expect((await introspect(homiio, assertion)).body.data).toEqual({ active: false });
    expect((await introspect(otherOfficial, assertion)).body.data).toEqual({ active: false });
    expect((await introspect(alia, assertion, { applicationId: otherOfficial.appId, credentialId: otherOfficial.credentialId })).body.data)
      .toEqual({ active: false });
    expect((await introspect(alia, assertion)).body.data).toMatchObject({ active: true });
  });

  it('rejects unexpected body members', async () => {
    const person = await signedInUser();
    const res = await post('/internal/native-agents/requester-assertions', serviceToken(homiio), {
      agentId: HOMIIO.aliaAgent.id,
      subjectToken: person.accessToken,
      requesterAccountId: 'victim',
    });
    expect(res.status).toBe(400);
  });
});
