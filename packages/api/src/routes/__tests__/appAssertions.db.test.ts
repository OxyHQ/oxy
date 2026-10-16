/**
 * ADR 0045 — an Oxy app proves which app it is with an Oxy-signed app assertion.
 *
 * The registry (`PUT /applications/:appId/recognition`, staff only) and the
 * exchange (`/apps/assertions/challenge`, `/apps/attest-keys`,
 * `/apps/assertions`) against real rows in Postgres. Replaced, and only these:
 * the bearer (`authMiddleware` takes the person, session and session
 * application from test headers — these tests are about what a session may
 * assert, not how it signed in), Google (a fake Play Integrity that decodes a
 * token into the verdict the test wrote), Apple (a test root CA, with devices
 * that attest and assert exactly as App Attest does) and the signing key.
 *
 * Every issued assertion is read back through `verifyAppAssertion` from
 * `@oxy.so/core/server`, the verifier a service runs.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { verifyAppAssertion } from '@oxy.so/core/server';
import type { PlayIntegrityVerdict } from '../../services/playIntegrity.service';
import { PlayIntegrityTokenRejectedError } from '../../services/playIntegrity.service';
import type { AppAssertionDependencies } from '../../services/appAssertion.service';
import { createTestAppAttestWorld } from '../../services/__fixtures__/appAttestFixtures';

jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    authMiddleware: (
      req: {
        headers: Record<string, string | undefined>;
        user?: unknown;
        sessionId?: string;
        oxyToken?: unknown;
      },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => {
      const userId = req.headers['x-test-user'];
      if (!userId) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const sessionId = req.headers['x-test-session'] ?? `session-${userId}`;
      req.user = { _id: userId, id: userId, isStaff: req.headers['x-test-staff'] === 'true' };
      req.sessionId = sessionId;
      req.oxyToken = {
        version: 2,
        subjectAccountId: userId,
        principalUserId: userId,
        sessionId,
        applicationId: req.headers['x-test-session-application'] ?? null,
        clientId: null,
        deviceSessionId: null,
        deviceContextId: null,
        scopes: [],
      };
      next();
    },
  };
});

jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: async () => {},
}));

let mockRuntime: AppAssertionDependencies;
jest.mock('../../services/appAssertion.service', () => ({
  ...jest.requireActual('../../services/appAssertion.service'),
  appAssertionRuntime: () => mockRuntime,
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { accountMembers } from '../../db/schema/accountMembers';
import { appAssertionChallenges } from '../../db/schema/appAssertionChallenges';
import { appAttestKeys } from '../../db/schema/appAttestKeys';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import appAssertionsRouter from '../appAssertions';
import applicationsRouter from '../applications';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const server = express();
server.use(express.json());
server.use('/applications', applicationsRouter);
server.use('/apps', appAssertionsRouter);
server.use(errorHandler);

const ISSUER = 'https://api.oxy.test';
const SIGNING = generateKeyPairSync('ed25519');
const KEY_ID = 'app-assertion-test';
const CERT = 'c0'.repeat(32);
const OTHER_CERT = 'd1'.repeat(32);
const TEAM = 'ABCDE12345';
const appleWorld = createTestAppAttestWorld();

/** Google, decoding a token into the verdict the test wrote into it. */
const decoded: { packageName: string; token: string }[] = [];
function integrityToken(verdict: PlayIntegrityVerdict): string {
  return Buffer.from(JSON.stringify(verdict)).toString('base64url');
}
const fakePlayIntegrity = {
  async decode(packageName: string, token: string): Promise<PlayIntegrityVerdict> {
    decoded.push({ packageName, token });
    if (token === 'garbage') throw new PlayIntegrityTokenRejectedError();
    return JSON.parse(Buffer.from(token, 'base64url').toString()) as PlayIntegrityVerdict;
  },
};

let now = new Date();
let playIntegrityConfigured = true;

beforeEach(() => {
  now = new Date();
  playIntegrityConfigured = true;
  decoded.length = 0;
  mockRuntime = {
    now: () => now,
    issuer: ISSUER,
    signing: () => ({ keyId: KEY_ID, privateKey: SIGNING.privateKey }),
    playIntegrity: () =>
      playIntegrityConfigured
        ? { cloudProjectNumber: '424242424242', client: fakePlayIntegrity }
        : null,
    appAttestRoot: () => appleWorld.root,
    appAttestEnvironments: () => ['production'],
  };
});

const resolvePublicKey = async (keyId: string) =>
  keyId === KEY_ID ? SIGNING.publicKey : undefined;

async function account(kind: 'personal' | 'organization'): Promise<string> {
  const [row] = await insertAccountFixtures(
    { kind, username: `assert-${kind}-${randomUUID().slice(0, 12)}` },
    { id: users.id },
  );
  return row.id;
}

/** Mention (owned by an organization a staff member administers), another app, a person. */
async function world() {
  const staff = await account('personal');
  const person = await account('personal');
  const org = await account('organization');
  await getDb()
    .insert(accountMembers)
    .values([{ accountId: org, memberUserId: staff, role: 'owner', status: 'active' }]);
  const app = async (name: string) => {
    const [row] = await getDb()
      .insert(applications)
      .values({ name: `${name} ${randomUUID()}`, ownerAccountId: org, status: 'active' })
      .returning({ id: applications.id });
    return row.id;
  };
  const mention = await app('Mention');
  const other = await app('Other');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const mentionIds = {
    origin: `https://mention-${suffix}.example`,
    packageName: `earth.mention.app${suffix}`,
    bundleId: `earth.mention.app${suffix}`,
  };
  const otherIds = {
    origin: `https://other-${suffix}.example`,
    packageName: `earth.other.app${suffix}`,
    bundleId: `earth.other.app${suffix}`,
  };
  const declare = (id: string, ids: typeof mentionIds) =>
    request(server)
      .put(`/applications/${id}/recognition`)
      .set('x-test-user', staff)
      .set('x-test-staff', 'true')
      .send({
        webOrigins: [ids.origin],
        android: { packageName: ids.packageName, signingCertSha256: [CERT] },
        ios: { teamId: TEAM, bundleId: ids.bundleId },
      });
  expect((await declare(mention, mentionIds)).status).toBe(200);
  expect((await declare(other, otherIds)).status).toBe(200);
  return { staff, person, org, mention, other, mentionIds, otherIds };
}

type World = Awaited<ReturnType<typeof world>>;

const as = (userId: string, sessionId = `session-${userId}`, sessionApplication?: string) => {
  const withHeaders = (test: request.Test) => {
    const t = test.set('x-test-user', userId).set('x-test-session', sessionId);
    return sessionApplication ? t.set('x-test-session-application', sessionApplication) : t;
  };
  return {
    challenge: (body: object) =>
      withHeaders(request(server).post('/apps/assertions/challenge')).send(body),
    attestKey: (body: object) => withHeaders(request(server).post('/apps/attest-keys')).send(body),
    assertion: (body: object, origin?: string) => {
      const test = withHeaders(request(server).post('/apps/assertions'));
      return (origin ? test.set('origin', origin) : test).send(body);
    },
  };
};

async function readBack(assertion: string, userId: string, sessionId = `session-${userId}`) {
  return verifyAppAssertion(assertion, {
    session: { userId, sessionId },
    issuer: ISSUER,
    resolvePublicKey,
    now,
  });
}

function playVerdict(
  w: World,
  requestHash: string,
  overrides: { app?: object; request?: object } = {},
) {
  return integrityToken({
    requestDetails: {
      requestPackageName: w.mentionIds.packageName,
      requestHash,
      timestampMillis: String(now.getTime()),
      ...overrides.request,
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: w.mentionIds.packageName,
      certificateSha256Digest: [Buffer.from(CERT, 'hex').toString('base64url')],
      ...overrides.app,
    },
  });
}

describe('the registry: only the staff lane declares how an application is recognised', () => {
  it('a staff member writes the whole declaration, and anyone who may read the app reads it', async () => {
    const w = await world();
    const read = await request(server)
      .get(`/applications/${w.mention}/recognition`)
      .set('x-test-user', w.staff);
    expect(read.status).toBe(200);
    expect(read.body.recognition).toMatchObject({
      applicationId: w.mention,
      webOrigins: [w.mentionIds.origin],
      android: { packageName: w.mentionIds.packageName, signingCertSha256: [CERT] },
      ios: { teamId: TEAM, bundleId: w.mentionIds.bundleId },
    });

    const replaced = await request(server)
      .put(`/applications/${w.mention}/recognition`)
      .set('x-test-user', w.staff)
      .set('x-test-staff', 'true')
      .send({ webOrigins: [], android: null, ios: null });
    expect(replaced.status).toBe(200);
    expect(replaced.body.recognition).toMatchObject({ webOrigins: [], android: null, ios: null });
  });

  it('refuses an owner who is not staff, and writes nothing', async () => {
    const w = await world();
    const refused = await request(server)
      .put(`/applications/${w.mention}/recognition`)
      .set('x-test-user', w.staff)
      .set('x-test-staff', 'false')
      .send({ webOrigins: ['https://attacker.example'], android: null, ios: null });
    expect(refused.status).toBe(403);
    const read = await request(server)
      .get(`/applications/${w.mention}/recognition`)
      .set('x-test-user', w.staff);
    expect(read.body.recognition.webOrigins).toEqual([w.mentionIds.origin]);
  });

  it('refuses an origin, package or iOS app that is another application’s', async () => {
    const w = await world();
    const put = (body: object) =>
      request(server)
        .put(`/applications/${w.other}/recognition`)
        .set('x-test-user', w.staff)
        .set('x-test-staff', 'true')
        .send({ webOrigins: [], android: null, ios: null, ...body });
    expect((await put({ webOrigins: [w.mentionIds.origin] })).status).toBe(409);
    expect(
      (
        await put({
          android: { packageName: w.mentionIds.packageName, signingCertSha256: [OTHER_CERT] },
        })
      ).status,
    ).toBe(409);
    expect((await put({ ios: { teamId: TEAM, bundleId: w.mentionIds.bundleId } })).status).toBe(
      409,
    );
    // A refused write leaves the previous declaration whole.
    const read = await request(server)
      .get(`/applications/${w.other}/recognition`)
      .set('x-test-user', w.staff);
    expect(read.body.recognition.webOrigins).toEqual([w.otherIds.origin]);
  });

  it('refuses a declaration that is not exact', async () => {
    const w = await world();
    const put = (body: object) =>
      request(server)
        .put(`/applications/${w.mention}/recognition`)
        .set('x-test-user', w.staff)
        .set('x-test-staff', 'true')
        .send(body);
    expect(
      (await put({ webOrigins: ['https://mention.earth/'], android: null, ios: null })).status,
    ).toBe(400);
    expect(
      (
        await put({
          webOrigins: [],
          android: { packageName: 'earth.mention', signingCertSha256: ['AB:CD'] },
          ios: null,
        })
      ).status,
    ).toBe(400);
  });
});

describe('web: the browser’s Origin', () => {
  it('issues a five-minute assertion for a registered origin, bound to the person and session', async () => {
    const w = await world();
    const issued = await as(w.person).assertion(
      { applicationId: w.mention, platform: 'web' },
      w.mentionIds.origin,
    );
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ applicationId: w.mention, platform: 'web' });
    expect(new Date(issued.body.expiresAt).getTime()).toBe(
      Math.floor(now.getTime() / 1000) * 1000 + 300_000,
    );
    await expect(readBack(issued.body.assertion, w.person)).resolves.toEqual({
      applicationId: w.mention,
      platform: 'web',
    });
    const claims = JSON.parse(
      Buffer.from(issued.body.assertion.split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: 'oxy-apps',
      sub: w.person,
      sid: `session-${w.person}`,
      app: w.mention,
      platform: 'web',
    });
    expect(claims.exp - claims.iat).toBe(300);
    expect(typeof claims.jti).toBe('string');

    // Another session, another person, or after it expired: no app.
    await expect(readBack(issued.body.assertion, w.person, 'session-other')).resolves.toBeNull();
    await expect(readBack(issued.body.assertion, w.staff)).resolves.toBeNull();
    now = new Date(now.getTime() + 301_000);
    await expect(readBack(issued.body.assertion, w.person)).resolves.toBeNull();
  });

  it('refuses a wrong origin, no origin, and another application’s origin', async () => {
    const w = await world();
    const ask = (origin?: string) =>
      as(w.person).assertion({ applicationId: w.mention, platform: 'web' }, origin);
    for (const origin of ['https://attacker.example', `${w.mentionIds.origin}:8443`, undefined]) {
      const refused = await ask(origin);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('origin_not_registered');
    }
    const otherOrigin = await ask(w.otherIds.origin);
    expect(otherOrigin.body.error).toBe('origin_not_registered');
  });

  it('refuses an application that is not active, and a session that is another application’s', async () => {
    const w = await world();
    const ownSession = await as(w.person, 'session-own', w.mention).assertion(
      { applicationId: w.mention, platform: 'web' },
      w.mentionIds.origin,
    );
    expect(ownSession.status).toBe(200);
    const otherSession = await as(w.person, 'session-other', w.other).assertion(
      { applicationId: w.mention, platform: 'web' },
      w.mentionIds.origin,
    );
    expect(otherSession.status).toBe(403);
    expect(otherSession.body.error).toBe('session_other_application');

    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, w.mention));
    const suspended = await as(w.person).assertion(
      { applicationId: w.mention, platform: 'web' },
      w.mentionIds.origin,
    );
    expect(suspended.status).toBe(403);
    expect(suspended.body.error).toBe('application_unavailable');
    const unknown = await as(w.person).assertion(
      { applicationId: randomUUID(), platform: 'web' },
      w.mentionIds.origin,
    );
    expect(unknown.body.error).toBe('application_unavailable');
  });

  it('refuses a platform the application does not declare', async () => {
    const w = await world();
    await request(server)
      .put(`/applications/${w.mention}/recognition`)
      .set('x-test-user', w.staff)
      .set('x-test-staff', 'true')
      .send({ webOrigins: [], android: null, ios: null });
    const refused = await as(w.person).assertion(
      { applicationId: w.mention, platform: 'web' },
      w.mentionIds.origin,
    );
    expect(refused.body.error).toBe('platform_not_registered');
    const challenge = await as(w.person).challenge({
      applicationId: w.mention,
      platform: 'android',
    });
    expect(challenge.body.error).toBe('platform_not_registered');
  });
});

describe('android: Play Integrity', () => {
  async function challenge(w: World, caller = as(w.person)) {
    const answer = await caller.challenge({ applicationId: w.mention, platform: 'android' });
    expect(answer.status).toBe(200);
    expect(answer.body.cloudProjectNumber).toBe('424242424242');
    return answer.body as { challenge: string; requestHash: string; expiresAt: string };
  }

  it('issues for a verdict naming the package, a registered certificate, a Play install and the challenge', async () => {
    const w = await world();
    const minted = await challenge(w);
    const issued = await as(w.person).assertion({
      applicationId: w.mention,
      platform: 'android',
      proof: { challenge: minted.challenge, integrityToken: playVerdict(w, minted.requestHash) },
    });
    expect(issued.status).toBe(200);
    expect(decoded).toEqual([{ packageName: w.mentionIds.packageName, token: expect.any(String) }]);
    await expect(readBack(issued.body.assertion, w.person)).resolves.toEqual({
      applicationId: w.mention,
      platform: 'android',
    });
    // The challenge is hashed at rest and spent.
    const [row] = await getDb()
      .select()
      .from(appAssertionChallenges)
      .where(eq(appAssertionChallenges.userId, w.person));
    expect(row?.usedAt).not.toBeNull();
    expect(row?.challengeHash).not.toBe(minted.challenge);
  });

  it.each([
    ['another package', { app: { packageName: 'earth.attacker.app' } }],
    [
      'an unregistered certificate',
      { app: { certificateSha256Digest: [Buffer.from(OTHER_CERT, 'hex').toString('base64url')] } },
    ],
    [
      'an install Play does not recognise',
      { app: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } },
    ],
    ['another request hash', { request: { requestHash: 'x'.repeat(43) } }],
  ])('refuses a verdict for %s', async (_name, overrides) => {
    const w = await world();
    const minted = await challenge(w);
    const refused = await as(w.person).assertion({
      applicationId: w.mention,
      platform: 'android',
      proof: {
        challenge: minted.challenge,
        integrityToken: playVerdict(w, minted.requestHash, overrides),
      },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('integrity_refused');
  });

  it('refuses a token Google will not decode', async () => {
    const w = await world();
    const minted = await challenge(w);
    const refused = await as(w.person).assertion({
      applicationId: w.mention,
      platform: 'android',
      proof: { challenge: minted.challenge, integrityToken: 'garbage' },
    });
    expect(refused.body.error).toBe('integrity_refused');
  });

  it('refuses a replayed challenge and token, before asking Google again', async () => {
    const w = await world();
    const minted = await challenge(w);
    const body = {
      applicationId: w.mention,
      platform: 'android',
      proof: { challenge: minted.challenge, integrityToken: playVerdict(w, minted.requestHash) },
    };
    expect((await as(w.person).assertion(body)).status).toBe(200);
    const replayed = await as(w.person).assertion(body);
    expect(replayed.status).toBe(403);
    expect(replayed.body.error).toBe('challenge_invalid');
    expect(decoded).toHaveLength(1);
  });

  it('refuses a challenge minted for another session, another person or another application', async () => {
    const w = await world();
    const minted = await challenge(w);
    const proof = {
      challenge: minted.challenge,
      integrityToken: playVerdict(w, minted.requestHash),
    };
    const otherSession = await as(w.person, 'session-2').assertion({
      applicationId: w.mention,
      platform: 'android',
      proof,
    });
    expect(otherSession.body.error).toBe('challenge_invalid');
    const otherPerson = await as(w.staff).assertion({
      applicationId: w.mention,
      platform: 'android',
      proof,
    });
    expect(otherPerson.body.error).toBe('challenge_invalid');
    const otherApp = await as(w.person).assertion({
      applicationId: w.other,
      platform: 'android',
      proof,
    });
    expect(otherApp.body.error).toBe('challenge_invalid');
  });

  it('refuses an expired challenge', async () => {
    const w = await world();
    const minted = await challenge(w);
    now = new Date(now.getTime() + 121_000);
    const refused = await as(w.person).assertion({
      applicationId: w.mention,
      platform: 'android',
      proof: { challenge: minted.challenge, integrityToken: playVerdict(w, minted.requestHash) },
    });
    expect(refused.body.error).toBe('challenge_invalid');
  });

  it('fails closed when Play Integrity is not configured', async () => {
    const w = await world();
    playIntegrityConfigured = false;
    const refused = await as(w.person).challenge({ applicationId: w.mention, platform: 'android' });
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe('integrity_unconfigured');
  });
});

describe('ios: App Attest', () => {
  const appIdOf = (w: World) => `${TEAM}.${w.mentionIds.bundleId}`;

  async function challenge(w: World, purpose: 'assertion' | 'attest_key', caller = as(w.person)) {
    const answer = await caller.challenge({ applicationId: w.mention, platform: 'ios', purpose });
    expect(answer.status).toBe(200);
    expect(answer.body.cloudProjectNumber).toBeUndefined();
    return answer.body as { challenge: string; requestHash: string };
  }

  async function registered(w: World) {
    const device = appleWorld.device(appIdOf(w));
    const minted = await challenge(w, 'attest_key');
    const answer = await as(w.person).attestKey({
      applicationId: w.mention,
      keyId: device.keyId,
      challenge: minted.challenge,
      attestation: device.attest(minted.requestHash),
    });
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ keyId: device.keyId });
    return device;
  }

  async function assertWith(
    w: World,
    device: ReturnType<typeof appleWorld.device>,
    counter: number,
    applicationId = w.mention,
  ) {
    const minted = await challenge(w, 'assertion');
    return as(w.person).assertion({
      applicationId,
      platform: 'ios',
      proof: {
        challenge: minted.challenge,
        keyId: device.keyId,
        assertion: device.assert(minted.requestHash, counter),
      },
    });
  }

  it('registers an attested key, then issues for assertions whose counter moves forward', async () => {
    const w = await world();
    const device = await registered(w);
    const first = await assertWith(w, device, 1);
    expect(first.status).toBe(200);
    await expect(readBack(first.body.assertion, w.person)).resolves.toEqual({
      applicationId: w.mention,
      platform: 'ios',
    });
    expect((await assertWith(w, device, 2)).status).toBe(200);
    const [key] = await getDb()
      .select()
      .from(appAttestKeys)
      .where(eq(appAttestKeys.keyId, device.keyId));
    expect(key?.signCount).toBe(2);
    expect(key?.environment).toBe('production');
  });

  it('refuses a counter that did not move forward', async () => {
    const w = await world();
    const device = await registered(w);
    expect((await assertWith(w, device, 5)).status).toBe(200);
    for (const counter of [5, 4]) {
      const refused = await assertWith(w, device, counter);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('assertion_invalid');
    }
  });

  it('refuses a replayed challenge and assertion', async () => {
    const w = await world();
    const device = await registered(w);
    const minted = await challenge(w, 'assertion');
    const body = {
      applicationId: w.mention,
      platform: 'ios',
      proof: {
        challenge: minted.challenge,
        keyId: device.keyId,
        assertion: device.assert(minted.requestHash, 1),
      },
    };
    expect((await as(w.person).assertion(body)).status).toBe(200);
    const replayed = await as(w.person).assertion(body);
    expect(replayed.body.error).toBe('challenge_invalid');
  });

  it('refuses an assertion over another challenge, and an attest_key challenge spent on an assertion', async () => {
    const w = await world();
    const device = await registered(w);
    const minted = await challenge(w, 'assertion');
    const signedOther = await as(w.person).assertion({
      applicationId: w.mention,
      platform: 'ios',
      proof: {
        challenge: minted.challenge,
        keyId: device.keyId,
        assertion: device.assert('another-request-hash', 1),
      },
    });
    expect(signedOther.body.error).toBe('assertion_invalid');

    const attestChallenge = await challenge(w, 'attest_key');
    const wrongPurpose = await as(w.person).assertion({
      applicationId: w.mention,
      platform: 'ios',
      proof: {
        challenge: attestChallenge.challenge,
        keyId: device.keyId,
        assertion: device.assert(attestChallenge.requestHash, 2),
      },
    });
    expect(wrongPurpose.body.error).toBe('challenge_invalid');
  });

  it('refuses a key it never registered, and a key registered for another application', async () => {
    const w = await world();
    const unregistered = appleWorld.device(appIdOf(w));
    const unknown = await assertWith(w, unregistered, 1);
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toBe('attest_key_unknown');

    const device = await registered(w);
    const minted = await as(w.person).challenge({
      applicationId: w.other,
      platform: 'ios',
      purpose: 'assertion',
    });
    const otherApp = await as(w.person).assertion({
      applicationId: w.other,
      platform: 'ios',
      proof: {
        challenge: minted.body.challenge,
        keyId: device.keyId,
        assertion: device.assert(minted.body.requestHash, 1),
      },
    });
    expect(otherApp.body.error).toBe('attest_key_unknown');
  });

  it('refuses an attestation for another bundle or team, over another challenge, or not from Apple', async () => {
    const w = await world();
    type Device = ReturnType<typeof appleWorld.device>;
    const cases: [string, (device: Device, requestHash: string) => string][] = [
      ['bundle', (device, hash) => device.attest(hash, { appId: `${TEAM}.earth.attacker.app` })],
      [
        'team',
        (device, hash) => device.attest(hash, { appId: `ZZZZZ99999.${w.mentionIds.bundleId}` }),
      ],
      ['challenge', (device) => device.attest('another-request-hash')],
      ['root', (device, hash) => device.attest(hash, { rogueIntermediate: true })],
      ['development', (device, hash) => device.attest(hash, { environment: 'development' })],
    ];
    for (const [, attestation] of cases) {
      const device = appleWorld.device(appIdOf(w));
      const minted = await challenge(w, 'attest_key');
      const refused = await as(w.person).attestKey({
        applicationId: w.mention,
        keyId: device.keyId,
        challenge: minted.challenge,
        attestation: attestation(device, minted.requestHash),
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('attestation_invalid');
    }
  });

  it('refuses registering the same key twice, and a replayed attest challenge', async () => {
    const w = await world();
    const device = appleWorld.device(appIdOf(w));
    const minted = await challenge(w, 'attest_key');
    const body = {
      applicationId: w.mention,
      keyId: device.keyId,
      challenge: minted.challenge,
      attestation: device.attest(minted.requestHash),
    };
    expect((await as(w.person).attestKey(body)).status).toBe(201);
    expect((await as(w.person).attestKey(body)).body.error).toBe('challenge_invalid');
    const again = await challenge(w, 'attest_key');
    const duplicate = await as(w.person).attestKey({
      ...body,
      challenge: again.challenge,
      attestation: device.attest(again.requestHash),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('attest_key_exists');
  });

  it('only iOS registers keys', async () => {
    const w = await world();
    const refused = await as(w.person).challenge({
      applicationId: w.mention,
      platform: 'android',
      purpose: 'attest_key',
    });
    expect(refused.status).toBe(400);
  });
});
