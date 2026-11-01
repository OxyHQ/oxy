/**
 * `deviceJoin.service` against a REAL Postgres — the browser bridge's server
 * half (ADR 0029 D2). The route suite (`routes/__tests__/browserBridge.test.ts`)
 * runs the whole story; this one pins the service's own guarantees: server-chosen
 * device ids, only live official applications, one winner per code, and a proof
 * check that never throws.
 */

import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

jest.mock('../session.service', () => ({
  __esModule: true,
  default: {
    deactivateSession: jest.fn().mockResolvedValue(true),
    getAccessToken: jest.fn(),
    validateSessionById: jest.fn(),
  },
}));

import { closePostgres, connectPostgres, getDb, type Transaction } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { deviceCredentials } from '../../db/schema/deviceCredentials';
import { deviceJoinCodes } from '../../db/schema/deviceJoinCodes';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { users } from '../../db/schema/users';
import { deviceJoinService, resolveProvenDeviceId } from '../deviceJoin.service';
import deviceSessionService from '../deviceSession.service';
import { canonicalizeOAuthRedirectUri } from '../oauthCode.service';

jest.setTimeout(20_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function transactionPid(tx: Transaction): Promise<number> {
  const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
  return Number(rows[0].pid);
}

async function waitForLockWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await getDb().execute(sql`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
    `);
    if (Number(rows[0].count) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('expected Postgres lock waiters did not appear');
}

async function waitForBlockedBy(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await getDb().execute(sql`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))
    `);
    if (Number(rows[0].count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('expected Postgres blocker did not appear');
}

async function officialApp(): Promise<{
  clientId: string;
  redirectUri: string;
  credentialId: string;
  applicationId: string;
}> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const redirectUri = `https://app-${randomUUID().slice(0, 8)}.example`;
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'first_party',
      isOfficial: true,
      redirectUris: [redirectUri],
      ownerAccountId: owner.id,
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'client',
      type: 'public',
      environment: 'production',
      publicKey: clientId,
    })
    .returning({ id: applicationCredentials.id });
  return { clientId, redirectUri, credentialId: credential.id, applicationId: app.id };
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

    const [device] = await getDb()
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, a.deviceId));
    expect(device.activeAccountId).toBeNull();
    const credentials = await getDb()
      .select({ secretHash: deviceCredentials.secretHash })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.deviceSessionId, device.id));
    expect(credentials).toEqual([
      { secretHash: createHash('sha256').update(a.deviceSecret).digest('hex') },
    ]);
  });
});

describe('issueJoinCode / redeemJoinCode', () => {
  it('accepts a pre-existing code, and signout invalidates another pre-existing code', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    const [row] = await getDb()
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, device.deviceId));
    const { verifier, challenge } = pkce();
    const legacyCode = randomUUID();
    const revokeCode = randomUUID();
    for (const code of [legacyCode, revokeCode]) {
      await getDb()
        .insert(deviceJoinCodes)
        .values({
          codeHash: createHash('sha256').update(code).digest('hex'),
          deviceSessionId: row.id,
          applicationId: app.applicationId,
          redirectUri: canonicalizeOAuthRedirectUri(app.redirectUri),
          codeChallenge: challenge,
          expiresAt: new Date(Date.now() + 60_000),
        });
    }
    expect(
      (
        await deviceJoinService.redeemJoinCode({
          code: legacyCode,
          codeVerifier: verifier,
          clientId: app.clientId,
          redirectUri: app.redirectUri,
        })
      ).ok,
    ).toBe(true);
    await deviceSessionService.signout(device.deviceId, { all: true });
    expect(
      await deviceJoinService.redeemJoinCode({
        code: revokeCode,
        codeVerifier: verifier,
        clientId: app.clientId,
        redirectUri: app.redirectUri,
      }),
    ).toEqual({ ok: false, reason: 'invalid_grant' });
  });
  it('signout-all invalidates a previously issued code, even for an empty device', async () => {
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
    await deviceSessionService.signout(device.deviceId, { all: true });
    expect(
      await deviceSessionService.getStateBySecret(device.deviceId, device.deviceSecret),
    ).toBeNull();
    expect(
      await deviceJoinService.redeemJoinCode({
        code: issued.code,
        codeVerifier: verifier,
        clientId: app.clientId,
        redirectUri: app.redirectUri,
      }),
    ).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('removing the final account invalidates codes but removing one of two accounts does not', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    const [first] = await getDb().insert(users).values({}).returning({ id: users.id });
    const [second] = await getDb().insert(users).values({}).returning({ id: users.id });
    await deviceSessionService.addAccount(device.deviceId, {
      accountId: first.id,
      sessionId: 's1',
    });
    await deviceSessionService.addAccount(device.deviceId, {
      accountId: second.id,
      sessionId: 's2',
    });
    const one = pkce();
    const firstCode = await deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: one.challenge,
    });
    if (!firstCode.ok) throw new Error(firstCode.reason);
    await deviceSessionService.signout(device.deviceId, { accountId: first.id });
    expect(
      (
        await deviceJoinService.redeemJoinCode({
          code: firstCode.code,
          codeVerifier: one.verifier,
          clientId: app.clientId,
          redirectUri: app.redirectUri,
        })
      ).ok,
    ).toBe(true);
    const two = pkce();
    const finalCode = await deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: two.challenge,
    });
    if (!finalCode.ok) throw new Error(finalCode.reason);
    await deviceSessionService.signout(device.deviceId, { accountId: second.id });
    expect(
      await deviceJoinService.redeemJoinCode({
        code: finalCode.code,
        codeVerifier: two.verifier,
        clientId: app.clientId,
        redirectUri: app.redirectUri,
      }),
    ).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('revalidates a holder when signout commits after the preliminary proof', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    const { challenge } = pkce();
    const ready = deferred<void>();
    const release = deferred<void>();
    const original = deviceSessionService.getStateBySecret.bind(deviceSessionService);
    const spy = jest
      .spyOn(deviceSessionService, 'getStateBySecret')
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        ready.resolve();
        await release.promise;
        return result;
      });
    const issue = deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: challenge,
    });
    try {
      await ready.promise;
      await deviceSessionService.signout(device.deviceId, { all: true });
    } finally {
      release.resolve();
      spy.mockRestore();
    }
    expect(await issue).toEqual({ ok: false, reason: 'invalid_device_secret' });
  });

  it('an issuance ahead of concurrent signout is committed then invalidated', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    const { verifier, challenge } = pkce();
    const ready = deferred<void>();
    const release = deferred<void>();
    const blocker = getDb().transaction(async (tx) => {
      await tx
        .select({ id: deviceSessions.id })
        .from(deviceSessions)
        .where(eq(deviceSessions.deviceId, device.deviceId))
        .for('update');
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const issue = deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: challenge,
    });
    let signout: ReturnType<typeof deviceSessionService.signout> | undefined;
    try {
      await waitForLockWaiters(1);
      signout = deviceSessionService.signout(device.deviceId, { all: true });
      await waitForLockWaiters(2);
    } finally {
      release.resolve();
    }
    await blocker;
    const issued = await issue;
    await signout;
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(issued.reason);
    expect(
      await deviceJoinService.redeemJoinCode({
        code: issued.code,
        codeVerifier: verifier,
        clientId: app.clientId,
        redirectUri: app.redirectUri,
      }),
    ).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('a rolled-back signout preserves both the holder and the outstanding code', async () => {
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
    const internals = deviceSessionService as unknown as {
      revokeHolderCredentials(tx: Transaction, id: string): Promise<void>;
    };
    const original = internals.revokeHolderCredentials.bind(deviceSessionService);
    const spy = jest
      .spyOn(internals, 'revokeHolderCredentials')
      .mockImplementation(async (tx, id) => {
        await original(tx, id);
        throw new Error('force rollback');
      });
    try {
      await expect(deviceSessionService.signout(device.deviceId, { all: true })).rejects.toThrow(
        'force rollback',
      );
    } finally {
      spy.mockRestore();
    }
    expect(
      await deviceSessionService.getStateBySecret(device.deviceId, device.deviceSecret),
    ).not.toBeNull();
    expect(
      (
        await deviceJoinService.redeemJoinCode({
          code: issued.code,
          codeVerifier: verifier,
          clientId: app.clientId,
          redirectUri: app.redirectUri,
        })
      ).ok,
    ).toBe(true);
  });

  it('a failed holder insert rolls back the code claim', async () => {
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
    const input = {
      code: issued.code,
      codeVerifier: verifier,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
    };
    const spy = jest
      .spyOn(deviceSessionService, 'issueDeviceSecretInTransaction')
      .mockRejectedValueOnce(new Error('force rollback'));
    try {
      await expect(deviceJoinService.redeemJoinCode(input)).rejects.toThrow('force rollback');
    } finally {
      spy.mockRestore();
    }
    expect((await deviceJoinService.redeemJoinCode(input)).ok).toBe(true);
    expect(await deviceJoinService.redeemJoinCode(input)).toEqual({
      ok: false,
      reason: 'invalid_grant',
    });
  });

  it('rejects already used or expired codes without waiting for the device lock', async () => {
    const device = await deviceJoinService.registerDevice();
    const app = await officialApp();
    const { verifier, challenge } = pkce();
    const used = await deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: challenge,
    });
    const expired = await deviceJoinService.issueJoinCode({
      ...device,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      codeChallenge: challenge,
    });
    if (!used.ok || !expired.ok) throw new Error('code issuance failed');
    const input = { codeVerifier: verifier, clientId: app.clientId, redirectUri: app.redirectUri };
    expect((await deviceJoinService.redeemJoinCode({ ...input, code: used.code })).ok).toBe(true);
    await getDb()
      .update(deviceJoinCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceJoinCodes.codeHash, createHash('sha256').update(expired.code).digest('hex')));
    const ready = deferred<void>();
    const release = deferred<void>();
    const blocker = getDb().transaction(async (tx) => {
      await tx
        .select({ id: deviceSessions.id })
        .from(deviceSessions)
        .where(eq(deviceSessions.deviceId, device.deviceId))
        .for('update');
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('spent or expired code waited on device lock')),
          2_000,
        );
      });
      const results = await Promise.race([
        Promise.all([
          deviceJoinService.redeemJoinCode({ ...input, code: used.code }),
          deviceJoinService.redeemJoinCode({ ...input, code: expired.code }),
        ]),
        timeout,
      ]);
      expect(results).toEqual([
        { ok: false, reason: 'invalid_grant' },
        { ok: false, reason: 'invalid_grant' },
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      release.resolve();
      await blocker;
    }
  });

  it('checks code expiration after waiting for the device lock', async () => {
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
    const ready = deferred<number>();
    const release = deferred<void>();
    const blocker = getDb().transaction(async (tx) => {
      await tx
        .select({ id: deviceSessions.id })
        .from(deviceSessions)
        .where(eq(deviceSessions.deviceId, device.deviceId))
        .for('update');
      ready.resolve(await transactionPid(tx));
      await release.promise;
      await tx
        .update(deviceJoinCodes)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(deviceJoinCodes.codeHash, createHash('sha256').update(issued.code).digest('hex')),
        );
    });
    const blockerPid = await ready.promise;
    const redemption = deviceJoinService.redeemJoinCode({
      code: issued.code,
      codeVerifier: verifier,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
    });
    try {
      await waitForBlockedBy(blockerPid);
    } finally {
      release.resolve();
    }
    await blocker;
    expect(await redemption).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('a signout that wins the device lock prevents a concurrent redemption', async () => {
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
    const ready = deferred<number>();
    const release = deferred<void>();
    const internals = deviceSessionService as unknown as {
      revokeHolderCredentials(tx: Transaction, id: string): Promise<void>;
    };
    const original = internals.revokeHolderCredentials.bind(deviceSessionService);
    const spy = jest
      .spyOn(internals, 'revokeHolderCredentials')
      .mockImplementation(async (tx, id) => {
        await original(tx, id);
        ready.resolve(await transactionPid(tx));
        await release.promise;
      });
    const signout = deviceSessionService.signout(device.deviceId, { all: true });
    let redemption: ReturnType<typeof deviceJoinService.redeemJoinCode> | undefined;
    try {
      const blockerPid = await ready.promise;
      redemption = deviceJoinService.redeemJoinCode({
        code: issued.code,
        codeVerifier: verifier,
        clientId: app.clientId,
        redirectUri: app.redirectUri,
      });
      await waitForBlockedBy(blockerPid);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
    await signout;
    expect(await redemption).toEqual({ ok: false, reason: 'invalid_grant' });
  });

  it('a redemption that wins the device lock issues before signout revokes its holder', async () => {
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
    const ready = deferred<number>();
    const release = deferred<void>();
    const original = deviceSessionService.issueDeviceSecretInTransaction.bind(deviceSessionService);
    const spy = jest
      .spyOn(deviceSessionService, 'issueDeviceSecretInTransaction')
      .mockImplementation(async (tx, id) => {
        ready.resolve(await transactionPid(tx));
        await release.promise;
        return original(tx, id);
      });
    const redemption = deviceJoinService.redeemJoinCode({
      code: issued.code,
      codeVerifier: verifier,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
    });
    let signout: ReturnType<typeof deviceSessionService.signout> | undefined;
    try {
      const blockerPid = await ready.promise;
      signout = deviceSessionService.signout(device.deviceId, { all: true });
      await waitForBlockedBy(blockerPid);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
    const result = await redemption;
    await signout;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(
      await deviceSessionService.getStateBySecret(result.deviceId, result.deviceSecret),
    ).toBeNull();
  });
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
    const input = {
      code: issued.code,
      codeVerifier: verifier,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
    };
    const outcomes = await Promise.all([
      deviceJoinService.redeemJoinCode(input),
      deviceJoinService.redeemJoinCode(input),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const winner = outcomes.find((o) => o.ok);
    expect(winner?.ok && winner.deviceId).toBe(device.deviceId);
  });
});

describe('resolveProvenDeviceId', () => {
  it('names the device a valid proof proves, and nothing otherwise', async () => {
    const device = await deviceJoinService.registerDevice();
    expect(await resolveProvenDeviceId(device)).toBe(device.deviceId);
    expect(
      await resolveProvenDeviceId({ deviceId: device.deviceId, deviceSecret: 'forged' }),
    ).toBeNull();
    expect(
      await resolveProvenDeviceId({
        deviceId: `other-${randomUUID()}`,
        deviceSecret: device.deviceSecret,
      }),
    ).toBeNull();
    expect(await resolveProvenDeviceId(undefined)).toBeNull();
  });
});
