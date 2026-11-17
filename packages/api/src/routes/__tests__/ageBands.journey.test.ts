/**
 * Age bands, end to end through the real routers and a real Postgres (ADR 0067):
 * what sign-up does with a date of birth, how an account below the minimum
 * unsupervised age comes to exist only under supervision, and which edits to a
 * date of birth a person may make themselves.
 */

import express from 'express';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

process.env.ACCESS_TOKEN_SECRET = 'age-band-test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'age-band-test-refresh-secret';
process.env.DEVICE_ID_SALT = 'age-band-test-device-id-salt-0123456789abcdef';

const mockSendCode = jest.fn();
const mockSendSignIn = jest.fn();
const mockSendReauth = jest.fn();
const mockSendNotice = jest.fn();

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../services/accountEmail.mail', () => ({
  sendVerificationCode: (...args: unknown[]) => mockSendCode(...args),
  sendSignInEmail: (...args: unknown[]) => mockSendSignIn(...args),
  sendReauthCode: (...args: unknown[]) => mockSendReauth(...args),
  sendSecurityNotice: (...args: unknown[]) => mockSendNotice(...args),
}));
jest.mock('../../config/email.config', () => ({ SMTP_RELAYS: [{ name: 'test-relay' }] }));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
  broadcastSupervisionChanged: jest.fn(),
}));
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/user.service', () => {
  const actual = jest.requireActual('../../services/user.service');
  actual.userService.purgeUserSocialGraph = jest.fn().mockResolvedValue(undefined);
  return actual;
});
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
  isOwnFederationDomain: jest.fn(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../utils/graphCache', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() },
}));

import { and, eq as equals } from 'drizzle-orm';
import { DATE_OF_BIRTH_REFUSALS } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { supervisionAudit, supervisionProfiles } from '../../db/schema/supervision';
import sessionService from '../../services/session.service';
import {
  acceptInvitation,
  correctDateOfBirth,
  getSupervisionState,
  inviteGuardian,
} from '../../services/supervision.service';
import { isSupervised } from '../../services/supervisionPolicy.service';
import { userService } from '../../services/user.service';
import { errorHandler } from '../../middleware/errorHandler';
import accountEmailRouter from '../accountEmail';
import signInRouter from '../signIn';
import usersRouter from '../users';

jest.setTimeout(60_000);

let server: http.Server;

async function call(method: string, path: string, body?: unknown, bearer?: string) {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

/** The profile inside the `{ data }` envelope `/users/me` answers with. */
function profile(response: { body: Record<string, unknown> }): Record<string, unknown> {
  const data = response.body.data;
  if (typeof data !== 'object' || data === null) throw new Error('the response carries no profile');
  return data as Record<string, unknown>;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/auth/email', accountEmailRouter);
  app.use('/auth', signInRouter);
  app.use('/users', usersRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

beforeEach(() => {
  for (const mock of [mockSendCode, mockSendSignIn, mockSendReauth, mockSendNotice])
    mock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});

/** The ISO date of someone who turned `years` exactly `daysAgo` days ago (UTC). */
function bornYearsAgo(years: number, daysAgo = 30): string {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() - daysAgo),
  );
  return date.toISOString().slice(0, 10);
}

async function signUp(dateOfBirth?: string) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const email = `age-${suffix}@example.test`;
  const username = `age${suffix}`;
  const started = await call('POST', '/auth/email/verify/start', { purpose: 'signup', email });
  expect(started.status).toBe(200);
  const sent = mockSendCode.mock.calls.filter(([address]) => address === email).pop();
  if (!sent) throw new Error(`no code was sent to ${email}`);
  const confirmed = await call('POST', '/auth/email/verify/confirm', {
    verificationId: started.body.verificationId,
    code: sent[1],
  });
  expect(confirmed.status).toBe(200);
  const created = await call('POST', '/auth/signup', {
    username,
    email,
    emailTicket: confirmed.body.ticket,
    ...(dateOfBirth === undefined ? {} : { dateOfBirth }),
  });
  return { created, email, username };
}

async function signedUp(dateOfBirth?: string) {
  const { created } = await signUp(dateOfBirth);
  expect(created.status).toBe(200);
  return {
    token: created.body.accessToken as string,
    userId: (created.body.user as { id: string }).id,
  };
}

async function profileOf(userId: string) {
  const [row] = await getDb()
    .select()
    .from(supervisionProfiles)
    .where(equals(supervisionProfiles.childAccountId, userId));
  return row;
}

describe('age bands at sign-up (ADR 0067)', () => {
  it('gives an adult the adult band and no supervision', async () => {
    const adult = await signedUp(bornYearsAgo(30));
    const me = await call('GET', '/users/me', undefined, adult.token);
    expect(me.status).toBe(200);
    expect(profile(me).ageBand).toBe('adult');
    expect(profile(me).isAdult).toBe(true);
    expect(await profileOf(adult.userId)).toBeUndefined();
    expect(await userService.getAgeBand(adult.userId)).toBe('adult');
  });

  it('gives a 15-year-old the teen band and an account of their own', async () => {
    const teen = await signedUp(bornYearsAgo(15));
    const me = await call('GET', '/users/me', undefined, teen.token);
    expect(me.status).toBe(200);
    expect(profile(me).ageBand).toBe('teen');
    expect(profile(me).isAdult).toBe(false);
    expect(await profileOf(teen.userId)).toBeUndefined();
  });

  it('changes band on the birthday itself, not a day early', async () => {
    const turnsThirteenTomorrow = await signedUp(bornYearsAgo(13, -1));
    expect(await userService.getAgeBand(turnsThirteenTomorrow.userId)).toBe('under13');
    const turnedThirteenToday = await signedUp(bornYearsAgo(13, 0));
    expect(await userService.getAgeBand(turnedThirteenToday.userId)).toBe('teen');
    const turnedEighteenToday = await signedUp(bornYearsAgo(18, 0));
    expect(await userService.getAgeBand(turnedEighteenToday.userId)).toBe('adult');
  });

  it('leaves an account created without a date with no band at all', async () => {
    const unknown = await signedUp();
    const me = await call('GET', '/users/me', undefined, unknown.token);
    expect(me.status).toBe(200);
    expect(profile(me).ageBand).toBeUndefined();
    expect(profile(me).isAdult).toBeUndefined();
    expect(await userService.getAgeBand(unknown.userId)).toBeUndefined();
  });

  it('refuses a date that is not a real past date', async () => {
    const future = await signUp('2999-01-01');
    expect(future.created.status).toBe(400);
    const impossible = await signUp('2010-02-30');
    expect(impossible.created.status).toBe(400);
  });
});

describe('an account below the minimum unsupervised age', () => {
  it('is created private, under supervision and awaiting a guardian', async () => {
    const child = await signedUp(bornYearsAgo(10));

    const [account] = await getDb()
      .select({ isPrivate: users.privacyIsPrivateAccount, dateOfBirth: users.dateOfBirth })
      .from(users)
      .where(equals(users.id, child.userId));
    expect(account?.isPrivate).toBe(true);
    expect(account?.dateOfBirth).toBe(bornYearsAgo(10));

    const supervision = await profileOf(child.userId);
    expect(supervision?.status).toBe('active');
    expect(supervision?.guardianAccountId).toBeNull();
    expect(supervision?.awaitingGuardianSince).toBeInstanceOf(Date);
    expect(await isSupervised(child.userId)).toBe(true);

    const trail = await getDb()
      .select({ action: supervisionAudit.action })
      .from(supervisionAudit)
      .where(equals(supervisionAudit.childAccountId, child.userId));
    expect(trail.map((row) => row.action)).toEqual(['guardian_required']);

    // The session sign-up minted is real: it post-dates the profile's
    // `sessionsValidAfter`, so the child can reach supervision to invite a guardian.
    const session = await sessionService.validateSession(child.token, {
      allowSupervisedPolicyEvaluation: true,
    });
    expect(session?.session.userId).toBe(child.userId);

    // It reads its own profile, and its band says why it is supervised.
    const me = await call('GET', '/users/me', undefined, child.token);
    expect(me.status).toBe(200);
    expect(profile(me).ageBand).toBe('under13');

    // On the wire it is the existing "no guardian available" state.
    const state = await getSupervisionState(child.userId);
    expect(state.self).toMatchObject({ status: 'orphaned', guardianAccountId: null });
  });

  it('is activated by its first guardian accepting the invitation', async () => {
    const child = await signedUp(bornYearsAgo(11));
    const guardian = await signedUp(bornYearsAgo(40));

    const invitation = await inviteGuardian(child.userId, guardian.userId);
    await acceptInvitation(invitation.id, guardian.userId);

    const supervision = await profileOf(child.userId);
    expect(supervision?.status).toBe('active');
    expect(supervision?.guardianAccountId).toBe(guardian.userId);
    expect(supervision?.awaitingGuardianSince).toBeNull();

    // Activation revokes what came before it, exactly as a voluntary enrolment does.
    expect(
      await sessionService.validateSession(child.token, { allowSupervisedPolicyEvaluation: true }),
    ).toBeNull();

    const activated = await getDb()
      .select({ action: supervisionAudit.action })
      .from(supervisionAudit)
      .where(
        and(
          equals(supervisionAudit.childAccountId, child.userId),
          equals(supervisionAudit.action, 'supervision_activated'),
        ),
      );
    expect(activated).toHaveLength(1);
  });

  it('does not hand a guarded account to a second guardian who accepts', async () => {
    const child = await signedUp(bornYearsAgo(9));
    const first = await signedUp(bornYearsAgo(41));
    const second = await signedUp(bornYearsAgo(42));

    await acceptInvitation((await inviteGuardian(child.userId, first.userId)).id, first.userId);
    await acceptInvitation((await inviteGuardian(child.userId, second.userId)).id, second.userId);

    const supervision = await profileOf(child.userId);
    expect(supervision?.guardianAccountId).toBe(first.userId);
    const consent = await getDb()
      .select({ action: supervisionAudit.action })
      .from(supervisionAudit)
      .where(
        and(
          equals(supervisionAudit.childAccountId, child.userId),
          equals(supervisionAudit.action, 'transfer_consent_recorded'),
        ),
      );
    expect(consent).toHaveLength(1);
  });

  it('cannot hold the awaiting marker once it has a guardian', async () => {
    const child = await signedUp(bornYearsAgo(10));
    const guardian = await signedUp(bornYearsAgo(40));
    await expect(
      getDb()
        .update(supervisionProfiles)
        .set({ guardianAccountId: guardian.userId })
        .where(equals(supervisionProfiles.childAccountId, child.userId)),
    ).rejects.toThrow();
  });
});

describe('editing a date of birth', () => {
  async function setDateOfBirth(token: string, dateOfBirth: string | null) {
    return call('PUT', '/users/me', { dateOfBirth }, token);
  }

  it('lets an account without one give it once', async () => {
    const person = await signedUp();
    const set = await setDateOfBirth(person.token, bornYearsAgo(16));
    expect(set.status).toBe(200);
    expect(profile(set).ageBand).toBe('teen');
  });

  it('lets a date be corrected within its band or to a younger one', async () => {
    const person = await signedUp(bornYearsAgo(30));
    expect((await setDateOfBirth(person.token, bornYearsAgo(31))).status).toBe(200);
    const younger = await setDateOfBirth(person.token, bornYearsAgo(16));
    expect(younger.status).toBe(200);
    expect(profile(younger).ageBand).toBe('teen');
  });

  it('refuses a change to an older band', async () => {
    const teen = await signedUp(bornYearsAgo(15));
    const older = await setDateOfBirth(teen.token, bornYearsAgo(19));
    expect(older.status).toBe(400);
    expect(JSON.stringify(older.body)).toContain(DATE_OF_BIRTH_REFUSALS.locked);
    expect(await userService.getAgeBand(teen.userId)).toBe('teen');
  });

  it('refuses to remove a date that is set', async () => {
    const teen = await signedUp(bornYearsAgo(15));
    const cleared = await setDateOfBirth(teen.token, null);
    expect(cleared.status).toBe(400);
    expect(JSON.stringify(cleared.body)).toContain(DATE_OF_BIRTH_REFUSALS.locked);
    expect(await userService.getAgeBand(teen.userId)).toBe('teen');
  });

  it('sends an existing account that declares under 13 to supervision instead', async () => {
    const person = await signedUp();
    const declared = await setDateOfBirth(person.token, bornYearsAgo(10));
    expect(declared.status).toBe(400);
    expect(JSON.stringify(declared.body)).toContain(DATE_OF_BIRTH_REFUSALS.supervisionRequired);
    expect(await userService.getAgeBand(person.userId)).toBeUndefined();
    expect(await profileOf(person.userId)).toBeUndefined();
  });
});

describe('a reviewed correction of a date of birth', () => {
  async function staffMember() {
    const person = await signedUp(bornYearsAgo(35));
    await getDb().update(users).set({ isStaff: true }).where(equals(users.id, person.userId));
    return person;
  }

  it('lets staff move a date to an older band, on evidence, and records it', async () => {
    const staff = await staffMember();
    const person = await signedUp(bornYearsAgo(15));

    await correctDateOfBirth(staff.userId, {
      accountId: person.userId,
      dateOfBirth: bornYearsAgo(25),
      evidenceReference: 'case-123',
      reauth: { password: 'unused-by-the-service' },
    });

    expect(await userService.getAgeBand(person.userId)).toBe('adult');
    const trail = await getDb()
      .select({
        action: supervisionAudit.action,
        actor: supervisionAudit.actorAccountId,
        evidence: supervisionAudit.evidenceReference,
      })
      .from(supervisionAudit)
      .where(equals(supervisionAudit.childAccountId, person.userId));
    expect(trail).toEqual([
      { action: 'date_of_birth_corrected', actor: staff.userId, evidence: 'case-123' },
    ]);
  });

  it('refuses anyone who is not staff, and staff correcting themselves', async () => {
    const staff = await staffMember();
    const bystander = await signedUp(bornYearsAgo(30));
    const person = await signedUp(bornYearsAgo(15));
    const correction = {
      dateOfBirth: bornYearsAgo(25),
      evidenceReference: 'case-124',
      reauth: { password: 'unused-by-the-service' },
    };

    await expect(
      correctDateOfBirth(bystander.userId, { accountId: person.userId, ...correction }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      correctDateOfBirth(staff.userId, { accountId: staff.userId, ...correction }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await userService.getAgeBand(person.userId)).toBe('teen');
  });

  it('does not put an unsupervised account below the minimum age', async () => {
    const staff = await staffMember();
    const person = await signedUp(bornYearsAgo(15));
    await expect(
      correctDateOfBirth(staff.userId, {
        accountId: person.userId,
        dateOfBirth: bornYearsAgo(10),
        evidenceReference: 'case-125',
        reauth: { password: 'unused-by-the-service' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await userService.getAgeBand(person.userId)).toBe('teen');
  });

  it('leaves supervision in place when a supervised account turns out to be older', async () => {
    const staff = await staffMember();
    const child = await signedUp(bornYearsAgo(10));
    await correctDateOfBirth(staff.userId, {
      accountId: child.userId,
      dateOfBirth: bornYearsAgo(14),
      evidenceReference: 'case-126',
      reauth: { password: 'unused-by-the-service' },
    });
    expect(await userService.getAgeBand(child.userId)).toBe('teen');
    expect(await isSupervised(child.userId)).toBe(true);
  });
});
