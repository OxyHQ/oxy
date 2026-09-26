/**
 * `deviceJoin.service` against a REAL Postgres — the browser bridge's server
 * half (ADR 0029 D2). The route suite (`routes/__tests__/browserBridge.test.ts`)
 * runs the whole story; this one pins the service's own guarantees: server-chosen
 * device ids, only live official applications, one winner per code, and a proof
 * check that never throws.
 */

import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

jest.mock('../session.service', () => ({
  __esModule: true,
  default: {
    deactivateSession: jest.fn().mockResolvedValue(true),
    getAccessToken: jest.fn(),
    validateSessionById: jest.fn(),
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { deviceCredentials } from '../../db/schema/deviceCredentials';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { users } from '../../db/schema/users';
import { deviceJoinService, resolveProvenDeviceId } from '../deviceJoin.service';

async function officialApp(): Promise<{ clientId: string; redirectUri: string; credentialId: string }> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const redirectUri = `https://app-${randomUUID().slice(0, 8)}.example`;
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, type: 'first_party', isOfficial: true, redirectUris: [redirectUri], ownerAccountId: owner.id })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({ applicationId: app.id, name: 'client', type: 'public', environment: 'production', publicKey: clientId })
    .returning({ id: applicationCredentials.id });
  return { clientId, redirectUri, credentialId: credential.id };
}

function pkce() {
  const verifier = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('registerDevice', () => {
  it('creates an empty device with a server-chosen id and exactly one credential', async () => {
    const a = await deviceJoinService.registerDevice();
    const b = await deviceJoinService.registerDevice();
    expect(a.deviceId).not.toBe(b.deviceId);

    const [device] = await getDb().select().from(deviceSessions).where(eq(deviceSessions.deviceId, a.deviceId));
    expect(device.activeAccountId).toBeNull();
    const credentials = await getDb()
      .select({ secretHash: deviceCredentials.secretHash })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.deviceSessionId, device.id));
    expect(credentials).toEqual([{ secretHash: createHash('sha256').update(a.deviceSecret).digest('hex') }]);
  });
});

describe('issueJoinCode / redeemJoinCode', () => {
  it('refuses a revoked client credential', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, app.credentialId));
    const outcome = await deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: pkce().challenge,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_client' });
  });

  it('matches an origin-only redirect URI with or without its trailing slash', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    const { verifier, challenge } = pkce();
    const issued = await deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: `${app.redirectUri}/`,
      codeChallenge: challenge,
    });
    if (!issued.ok) throw new Error(issued.reason);
    const redeemed = await deviceJoinService.redeemJoinCode({
      code: issued.code,
      codeVerifier: verifier,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
    });
    expect(redeemed.ok).toBe(true);
  });

  it('two concurrent redemptions of one code: exactly one wins', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    const { verifier, challenge } = pkce();
    const issued = await deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: challenge,
    });
    if (!issued.ok) throw new Error(issued.reason);
    const input = { code: issued.code, codeVerifier: verifier, clientId: app.clientId, redirectUri: app.redirectUri };
    const outcomes = await Promise.all([deviceJoinService.redeemJoinCode(input), deviceJoinService.redeemJoinCode(input)]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const winner = outcomes.find((o) => o.ok);
    expect(winner && winner.ok && winner.deviceId).toBe(device.deviceId);
  });
});

describe('resolveProvenDeviceId', () => {
  it('names the device a valid proof proves, and nothing otherwise', async () => {
    const device = await deviceJoinService.registerDevice();
    expect(await resolveProvenDeviceId(device)).toBe(device.deviceId);
    expect(await resolveProvenDeviceId({ deviceId: device.deviceId, deviceSecret: 'forged' })).toBeNull();
    expect(await resolveProvenDeviceId({ deviceId: `other-${randomUUID()}`, deviceSecret: device.deviceSecret })).toBeNull();
    expect(await resolveProvenDeviceId(undefined)).toBeNull();
  });
});
