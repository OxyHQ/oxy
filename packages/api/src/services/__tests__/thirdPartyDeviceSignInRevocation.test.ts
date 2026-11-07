/**
 * `revokeThirdPartyDeviceSignIns` (`scripts/revoke-third-party-device-signins.ts`)
 * against the REAL Postgres, session service and device lane.
 *
 * A device sign-in a non-official application received before #2215 is
 * rebuilt here the way the approval and the claim built it then: a session
 * named "<application> App" on a fresh device (`sessions.application_id`
 * NULL), registered on that device with a restore secret
 * (`finalizeDeviceLogin`), and the claimed `auth_sessions` row (kept, or
 * already swept by the expiry sweep).
 *
 * What is pinned:
 *  - a dry run counts and changes nothing;
 *  - `apply` ends the device: its sessions (also one the restore secret minted
 *    later), its restore secret and its accounts, with one `device_removed`
 *    entry per affected account, whether `auth_sessions` still has the claim or
 *    only the session-label records do;
 *  - an OFFICIAL application's QR sign-in is never touched, nor a third
 *    party's whose label an official application also produces;
 *  - a second run ends and writes nothing (idempotent);
 *  - `authSessionsOnly` leaves the label-only sign-ins alone;
 *  - the report carries counts only.
 */
import { randomUUID } from 'node:crypto';

// Real tokens: every session needs its own (the shared setup mocks them).
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));

import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { securityActivities } from '../../db/schema/securityActivities';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { finalizeDeviceLogin } from '../deviceLogin.service';
import { deviceSessionService } from '../deviceSession.service';
import sessionService from '../session.service';
import {
  deviceSignInLabel,
  revokeThirdPartyDeviceSignIns,
  THIRD_PARTY_DEVICE_SIGN_IN_REVOKED,
} from '../thirdPartyDeviceSignInRevocation';

type AppFields = Partial<typeof applications.$inferInsert>;

const OFFICIAL: AppFields = { type: 'first_party', isOfficial: true, status: 'active' };
const THIRD_PARTY: AppFields = { type: 'third_party', status: 'active' };

const REQ = { headers: { 'user-agent': 'jest', 'accept-language': 'en-US' } } as never;

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}` })
    .returning({ id: users.id });
  return row.id;
}

async function application(fields: AppFields, name = `App ${randomUUID()}`) {
  const [app] = await getDb()
    .insert(applications)
    .values({
      name,
      redirectUris: ['https://example.test/cb'],
      ...fields,
      ownerAccountId: await account(),
    })
    .returning({ id: applications.id, name: applications.name });
  return app;
}

interface SignIn {
  userId: string;
  sessionId: string;
  deviceId: string;
  deviceSecret: string;
}

/**
 * A device sign-in of `app`, approved and claimed the way it was before #2215:
 * the approval's session on a fresh device, named by the application, then the
 * claim's registration and restore secret. `swept`: the `auth_sessions` row
 * is gone, as the expiry sweep leaves it an hour after its deadline.
 */
async function deviceSignIn(
  app: { id: string; name: string },
  options: { swept?: boolean } = {},
): Promise<SignIn> {
  const userId = await account();
  const session = await sessionService.createSession(userId, REQ, {
    deviceName: deviceSignInLabel(app.name),
    deviceId: randomUUID(),
  });
  const { deviceSecret } = await finalizeDeviceLogin({
    session: { sessionId: session.sessionId, deviceId: session.deviceId },
    userId,
  });
  if (!deviceSecret) throw new Error('the claim issued no restore secret');
  if (!options.swept) {
    await getDb()
      .insert(authSessions)
      .values({
        sessionToken: `at_${randomUUID().replace(/-/g, '')}`,
        applicationId: app.id,
        status: 'consumed',
        purpose: 'device_sign_in',
        authorizedUserId: userId,
        authorizedSessionId: session.sessionId,
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
  }
  return { userId, sessionId: session.sessionId, deviceId: session.deviceId, deviceSecret };
}

async function isActive(sessionId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ isActive: sessions.isActive })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId));
  return row?.isActive === true;
}

async function restoreSecretWorks(signIn: SignIn): Promise<boolean> {
  return (
    (await deviceSessionService.getStateBySecret(signIn.deviceId, signIn.deviceSecret)) !== null
  );
}

async function revocationEntries(userId: string) {
  return getDb()
    .select({
      eventType: securityActivities.eventType,
      deviceId: securityActivities.deviceId,
      metadata: securityActivities.metadata,
      severity: securityActivities.severity,
    })
    .from(securityActivities)
    .where(
      and(
        eq(securityActivities.userId, userId),
        eq(securityActivities.eventType, 'device_removed'),
      ),
    );
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

// Whatever other suites in this worker's database left (their own third-party
// sign-ins) is ended first, so the counts below are this case's own.
beforeEach(async () => {
  await revokeThirdPartyDeviceSignIns(getDb(), { apply: true });
});

describe('revokeThirdPartyDeviceSignIns', () => {
  it('a dry run counts the third party sign-ins and changes nothing', async () => {
    const thirdParty = await application(THIRD_PARTY);
    const claimed = await deviceSignIn(thirdParty);
    const swept = await deviceSignIn(thirdParty, { swept: true });

    const report = await revokeThirdPartyDeviceSignIns(getDb(), { apply: false });

    expect(report).toMatchObject({
      apply: false,
      devicesWithAccess: 2,
      sessions: 2,
      restoreSecrets: 2,
      accounts: 2,
      auditEntries: 0,
    });
    expect(report.found.authSessions).toBeGreaterThanOrEqual(1);
    expect(report.found.signInRecords).toBeGreaterThanOrEqual(2);
    for (const signIn of [claimed, swept]) {
      expect(await isActive(signIn.sessionId)).toBe(true);
      expect(await restoreSecretWorks(signIn)).toBe(true);
      expect(await revocationEntries(signIn.userId)).toHaveLength(0);
    }
  });

  it("apply ends each third party's device: its sessions, its restore secret, its accounts, and says so on the account's trail", async () => {
    const thirdParty = await application(THIRD_PARTY);
    const claimed = await deviceSignIn(thirdParty);
    const swept = await deviceSignIn(thirdParty, { swept: true });
    // Another account signed in on the same device later: the restore secret
    // mints its bearers too.
    const otherUserId = await account();
    const minted = await sessionService.createSession(otherUserId, REQ, {
      deviceName: 'Some browser',
      deviceId: claimed.deviceId,
    });
    await finalizeDeviceLogin({
      session: { sessionId: minted.sessionId, deviceId: minted.deviceId },
      userId: otherUserId,
      issueSecret: false,
    });

    const report = await revokeThirdPartyDeviceSignIns(getDb(), { apply: true });

    expect(report).toMatchObject({
      apply: true,
      devicesWithAccess: 2,
      sessions: 3,
      restoreSecrets: 2,
      accounts: 3,
      auditEntries: 3,
    });
    for (const signIn of [claimed, swept]) {
      expect(await isActive(signIn.sessionId)).toBe(false);
      expect(await restoreSecretWorks(signIn)).toBe(false);
      expect((await deviceSessionService.getState(signIn.deviceId)).accounts).toHaveLength(0);
      const [entry] = await revocationEntries(signIn.userId);
      expect(entry).toMatchObject({
        eventType: 'device_removed',
        deviceId: signIn.deviceId,
        severity: 'high',
        metadata: {
          reason: THIRD_PARTY_DEVICE_SIGN_IN_REVOKED,
          deviceName: deviceSignInLabel(thirdParty.name),
        },
      });
    }
    expect(await isActive(minted.sessionId)).toBe(false);
    expect(await revocationEntries(otherUserId)).toHaveLength(1);
  });

  it("never touches an official application's QR sign-in, nor a label an official application also produces", async () => {
    const officialApp = await application(OFFICIAL);
    const official = await deviceSignIn(officialApp);
    // A third party named like the official app: its sign-in carries the same
    // label, so only its precise record could name it, and that is swept.
    const lookalike = await application(THIRD_PARTY, officialApp.name);
    const ambiguous = await deviceSignIn(lookalike, { swept: true });
    const thirdParty = await deviceSignIn(await application(THIRD_PARTY));

    const report = await revokeThirdPartyDeviceSignIns(getDb(), { apply: true });

    expect(report.devicesWithAccess).toBe(1);
    expect(report.ambiguousLabels).toBeGreaterThanOrEqual(1);
    expect(await isActive(thirdParty.sessionId)).toBe(false);
    for (const untouched of [official, ambiguous]) {
      expect(await isActive(untouched.sessionId)).toBe(true);
      expect(await restoreSecretWorks(untouched)).toBe(true);
      expect((await deviceSessionService.getState(untouched.deviceId)).accounts).toHaveLength(1);
      expect(await revocationEntries(untouched.userId)).toHaveLength(0);
    }
  });

  it('an application that is not active is not official: its sign-ins end too', async () => {
    const suspended = await application({
      type: 'first_party',
      isOfficial: true,
      status: 'suspended',
    });
    const signIn = await deviceSignIn(suspended);
    const report = await revokeThirdPartyDeviceSignIns(getDb(), { apply: true });
    expect(report.devicesWithAccess).toBe(1);
    expect(await isActive(signIn.sessionId)).toBe(false);
    expect(await restoreSecretWorks(signIn)).toBe(false);
  });

  it('is idempotent: a second run ends nothing and writes no audit entry', async () => {
    const thirdParty = await application(THIRD_PARTY);
    const signIn = await deviceSignIn(thirdParty);
    await revokeThirdPartyDeviceSignIns(getDb(), { apply: true });

    const again = await revokeThirdPartyDeviceSignIns(getDb(), { apply: true });

    expect(again).toMatchObject({
      devicesWithAccess: 0,
      sessions: 0,
      restoreSecrets: 0,
      accounts: 0,
      auditEntries: 0,
    });
    // Still found (its records stay), and counted, but nothing is left to end.
    expect(again.devices).toBeGreaterThanOrEqual(1);
    expect(await revocationEntries(signIn.userId)).toHaveLength(1);
  });

  it('authSessionsOnly uses the precise record alone', async () => {
    const thirdParty = await application(THIRD_PARTY);
    const claimed = await deviceSignIn(thirdParty);
    const swept = await deviceSignIn(thirdParty, { swept: true });

    const report = await revokeThirdPartyDeviceSignIns(getDb(), {
      apply: true,
      authSessionsOnly: true,
    });

    expect(report.found.signInRecords).toBe(0);
    expect(report.devicesWithAccess).toBe(1);
    expect(await isActive(claimed.sessionId)).toBe(false);
    expect(await isActive(swept.sessionId)).toBe(true);
    expect(await restoreSecretWorks(swept)).toBe(true);
  });

  it('reports counts only: no account, device, session or secret', async () => {
    const thirdParty = await application(THIRD_PARTY);
    const signIn = await deviceSignIn(thirdParty);
    const report = await revokeThirdPartyDeviceSignIns(getDb(), { apply: false });
    const printed = JSON.stringify(report);
    for (const value of [signIn.userId, signIn.deviceId, signIn.sessionId, signIn.deviceSecret]) {
      expect(printed).not.toContain(value);
    }
    expect(printed).not.toContain(thirdParty.name);
  });
});
