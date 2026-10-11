/**
 * A bot is a complete account (issue #1520, I01) — against a REAL Postgres.
 *
 * Each case pairs a bot with a person in the same position and asserts the same
 * answer, or asserts the isolation a bot must keep:
 *
 *  - the same role over the same account grants the same permissions;
 *  - a bot nobody delegated is refused, and a revoked delegation ends the
 *    session acting as the bot;
 *  - the session authority reports the ACTOR off the row: a bot acting
 *    unoperated is its own actor, a delegated session names the person, and a
 *    forged header changes neither;
 *  - money a bot receives and spends lands on the bot's own balance and
 *    receipts — never its owner's — and costs exactly what it costs a person.
 *
 * Money here is test-database ledger entries only: nothing reaches a processor.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: {
    logDeviceAdded: jest.fn().mockResolvedValue(undefined),
    logSignIn: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { accountActorChainSchema, buildAgentProofMessage } from '@oxy.so/contracts';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { requestAgentChallenge, verifyAgentChallenge } from '../agentKeyAuth.service';
import SignatureService from '../signature.service';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { users } from '../../db/schema/users';
import { SessionController } from '../../controllers/session.controller';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import { accountService } from '../account.service';
import { verifyDelegatedSubject } from '../authSession.service';
import {
  getAccountBalance,
  provisionBillingProfile,
  recordTopUp,
  reserve,
  settle,
} from '../inferenceLedger.service';
import sessionService from '../session.service';

jest.setTimeout(60_000);

function request(headers: Record<string, string> = {}): Request {
  return {
    headers: { 'user-agent': 'jest', 'accept-language': 'en-US', ...headers },
  } as unknown as Request;
}

async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 12);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${suffix}`, ...over })
    .returning({ id: users.id });
  return row.id;
}

/** A bot under `ownerId`, the way `POST /accounts` hangs one: child + ancestor edge + owner membership. */
async function botOwnedBy(ownerId: string): Promise<string> {
  const botId = await account({
    kind: 'bot',
    username: `agent${randomUUID().slice(0, 8)}bot`,
    parentAccountId: ownerId,
  });
  await getDb().execute(
    sql`insert into user_ancestors (user_id, depth, ancestor_id) values (${botId}, 0, ${ownerId})`,
  );
  await getDb()
    .insert(accountMembers)
    .values({ accountId: botId, memberUserId: ownerId, role: 'owner', status: 'active' });
  return botId;
}

/** Real agent proof; no session is seeded for autonomous parity cases. */
async function autonomousLogin(botId: string) {
  const privateKey = randomUUID().replace(/-/g, '').padStart(64, '0');
  const publicKey = SignatureService.canonicalizePublicKey(deriveSecp256k1PublicKey(privateKey));
  await getDb().insert(userAuthMethods).values({
    userId: botId,
    type: 'agent_key',
    methodPublicKey: publicKey,
    label: 'parity',
    enrollmentMethod: 'governor',
  });
  const claims = await requestAgentChallenge(publicKey);
  const timestamp = Date.now();
  return verifyAgentChallenge(
    publicKey,
    {
      challenge: claims.challenge,
      timestamp,
      signature: SignatureService.signMessage(
        buildAgentProofMessage(claims, timestamp),
        privateKey,
      ),
    },
    request(),
  );
}

async function financialSubject(sessionId: string): Promise<string> {
  const live = await sessionService.validateSessionById(sessionId, false, { useCache: false });
  if (!live) throw new Error('Financial fixture requires a live session');
  const subject = live.session.userId;
  const actor = live.session.operatedByUserId ?? subject;
  const access = await accountService.resolveEffectiveAccess(actor, subject, sessionId);
  if (!access?.permissions.includes('billing:manage'))
    throw new Error('Financial authority denied');
  return subject;
}

interface CapturedResponse {
  statusCode: number;
  body: Record<string, unknown> | undefined;
}

/** Drive `GET /session/validate/:id` the way Express would, without a server. */
async function validate(
  sessionId: string,
  headers: Record<string, string> = {},
): Promise<CapturedResponse> {
  const captured: CapturedResponse = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  const req = {
    ...request(headers),
    params: { sessionId },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  await SessionController.validateSession(req, res);
  return captured;
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  sessionCache.clear();
  userCache.clear();
});

describe('roles do not depend on kind', () => {
  it.each(['owner', 'admin', 'editor', 'viewer'] as const)(
    'a bot member and a person member with role %s get the same access to one organization',
    async (role) => {
      const founder = await account();
      const org = await account({ kind: 'organization', parentAccountId: founder });
      const person = await account();
      const bot = await botOwnedBy(founder);
      await getDb()
        .insert(accountMembers)
        .values([
          { accountId: org, memberUserId: person, role, status: 'active' },
          { accountId: org, memberUserId: bot, role, status: 'active' },
        ]);

      const personAccess = await accountService.resolveEffectiveAccess(person, org);
      const botAccess = await accountService.resolveEffectiveAccess(bot, org);

      expect(personAccess).not.toBeNull();
      expect(botAccess?.role).toBe(personAccess?.role);
      expect([...(botAccess?.permissions ?? [])].sort()).toEqual(
        [...(personAccess?.permissions ?? [])].sort(),
      );
      expect(await accountService.verifyActingAs(bot, org)).toBe(
        await accountService.verifyActingAs(person, org),
      );
    },
  );
});

describe('a bot keeps its isolation', () => {
  it('refuses acting as a bot nobody delegated to the caller', async () => {
    const owner = await account();
    const stranger = await account();
    const foreignBot = await botOwnedBy(owner);

    expect(await accountService.verifyActingAs(stranger, foreignBot)).toBeNull();
    expect(await verifyDelegatedSubject(stranger, foreignBot)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    // Positive control: the owner who holds `account:act_as` is admitted.
    expect(await verifyDelegatedSubject(owner, foreignBot)).toEqual({ ok: true, role: 'owner' });
  });

  it('ends a session acting as the bot once the delegation is revoked', async () => {
    const owner = await account();
    const operator = await account();
    const bot = await botOwnedBy(owner);
    await getDb()
      .insert(accountMembers)
      .values({ accountId: bot, memberUserId: operator, role: 'admin', status: 'active' });
    const session = await sessionService.createSession(bot, request(), {
      deviceId: `dev-${randomUUID()}`,
      operatedByUserId: operator,
    });
    expect(await sessionService.validateSessionById(session.sessionId, false)).not.toBeNull();

    await getDb().delete(accountMembers).where(eq(accountMembers.memberUserId, operator));
    sessionCache.clear();

    // `useCache: false` is the authority-decision read (ADR 0025): it re-asks
    // the membership at once. The ordinary per-request path re-asks within
    // `MANAGED_SESSION_RECHECK_MS`; that bounded window is #1522's (I03)
    // freshness contract, not a bot-specific rule.
    expect(
      await sessionService.validateSessionById(session.sessionId, false, { useCache: false }),
    ).toBeNull();
    // A revocation, so the session is destroyed: the plain path refuses it too.
    expect(await sessionService.validateSessionById(session.sessionId, false)).toBeNull();
  });
});

describe('the session authority reports the actor off the row', () => {
  it('records a bot acting with nobody operating it as its own actor — never its owner', async () => {
    const owner = await account();
    const bot = await botOwnedBy(owner);
    const session = await autonomousLogin(bot);

    const res = await validate(session.sessionId);

    expect(res.statusCode).toBe(200);
    const actor = accountActorChainSchema.parse(res.body?.actor);
    expect(actor).toEqual({
      schemaVersion: 1,
      effectiveAccountId: bot,
      actorAccountId: bot,
      delegated: false,
    });
    expect(actor.actorAccountId).not.toBe(owner);
  });

  it('distinguishes the person from the effective account on a delegated session', async () => {
    const owner = await account();
    const bot = await botOwnedBy(owner);
    const session = await sessionService.createSession(bot, request(), {
      deviceId: `dev-${randomUUID()}`,
      operatedByUserId: owner,
    });

    const res = await validate(session.sessionId);

    expect(accountActorChainSchema.parse(res.body?.actor)).toEqual({
      schemaVersion: 1,
      effectiveAccountId: bot,
      actorAccountId: owner,
      delegated: true,
    });
  });

  it('is not moved by forged identity headers', async () => {
    const owner = await account();
    const intruder = await account();
    const bot = await botOwnedBy(owner);
    const session = await autonomousLogin(bot);

    const res = await validate(session.sessionId, {
      'x-oxy-user-id': intruder,
      'x-oxy-actor-id': intruder,
      'x-oxy-operator-id': intruder,
    });

    const actor = accountActorChainSchema.parse(res.body?.actor);
    expect(actor.actorAccountId).toBe(bot);
    expect(actor.effectiveAccountId).toBe(bot);
  });

  it('gives a person session the same shape, with the person as its own actor', async () => {
    const person = await account();
    const session = await sessionService.createSession(person, request(), {
      deviceId: `dev-${randomUUID()}`,
    });

    const res = await validate(session.sessionId);

    expect(accountActorChainSchema.parse(res.body?.actor)).toEqual({
      schemaVersion: 1,
      effectiveAccountId: person,
      actorAccountId: person,
      delegated: false,
    });
  });
});

describe('a bot holds, receives and spends its own money like a person', () => {
  async function priceVersion(): Promise<string> {
    const [version] = await getDb()
      .insert(priceVersions)
      .values({
        modelReference: `oxy/parity-${randomUUID().slice(0, 8)}`,
        provider: 'oxy-hosted',
        status: 'active',
        effectiveFrom: new Date(Date.now() - 60_000),
      })
      .returning({ id: priceVersions.id });
    await getDb()
      .insert(priceVersionUnitPrices)
      .values([
        {
          priceVersionId: version.id,
          unit: 'input_tokens',
          amount: '3.000000000000',
          per: 1_000_000,
        },
        {
          priceVersionId: version.id,
          unit: 'output_tokens',
          amount: '15.000000000000',
          per: 1_000_000,
        },
      ]);
    return version.id;
  }

  /** Own billing profile, an application it owns, and a simulated top-up. */
  async function fundedSubject(accountId: string) {
    const [application] = await getDb()
      .insert(applications)
      .values({ name: `Parity ${randomUUID().slice(0, 8)}`, ownerAccountId: accountId })
      .returning({ id: applications.id });
    const [credential] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: application.id,
        name: 'parity',
        publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
        type: 'service',
        environment: 'production',
      })
      .returning({ id: applicationCredentials.id });
    await provisionBillingProfile({ accountId });
    const received = await recordTopUp({
      idempotencyKey: `parity-fund-${randomUUID()}`,
      accountId,
      currency: 'USD',
      amount: '10.000000000000',
      actor: { kind: 'machine' },
    });
    return { applicationId: application.id, credentialId: credential.id, received };
  }

  async function spend(
    accountId: string,
    subject: { applicationId: string; credentialId: string },
  ) {
    const priceVersionId = await priceVersion();
    const attribution = {
      accountId,
      applicationId: subject.applicationId,
      applicationCredentialId: subject.credentialId,
      requestId: `req-${randomUUID()}`,
      environment: 'production' as const,
    };
    const reserved = await reserve({
      idempotencyKey: `r-${randomUUID()}`,
      attribution,
      ceilingPriceVersionId: priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (reserved.status !== 'reserved') throw new Error(`reserve failed: ${reserved.status}`);
    const settled = await settle({
      idempotencyKey: `s-${randomUUID()}`,
      reservationId: reserved.reservation.reservationId,
      attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1000, output_tokens: 200 },
      resolvedModelReference: 'oxy/test',
      servingProvider: 'oxy-hosted',
      priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error(`settle failed: ${settled.status}`);
    return { reserved, settled };
  }

  it('credits funds the bot receives to the bot, not to its owner', async () => {
    const owner = await account();
    await provisionBillingProfile({ accountId: owner });
    const bot = await botOwnedBy(owner);

    const botSession = await autonomousLogin(bot);
    await fundedSubject(await financialSubject(botSession.sessionId));

    const botBalance = await getAccountBalance(getDb(), bot, 'USD');
    const ownerBalance = await getAccountBalance(getDb(), owner, 'USD');
    expect(Number(botBalance?.purchasedBalance)).toBe(10);
    expect(Number(ownerBalance?.purchasedBalance)).toBe(0);
  });

  it('charges the bot its own balance, writes the receipt to the bot, and costs what a person pays', async () => {
    const owner = await account();
    await provisionBillingProfile({ accountId: owner });
    const bot = await botOwnedBy(owner);
    const person = await account();

    const botSession = await autonomousLogin(bot);
    const personSession = await sessionService.createSession(person, request(), {
      deviceId: randomUUID(),
    });
    const botSubject = await fundedSubject(await financialSubject(botSession.sessionId));
    const personSubject = await fundedSubject(await financialSubject(personSession.sessionId));

    const botSpend = await spend(await financialSubject(botSession.sessionId), botSubject);
    const personSpend = await spend(await financialSubject(personSession.sessionId), personSubject);

    // Same price, same units: the kind changes nothing commercial.
    expect(botSpend.settled.receipt.billedAmount).toBe(personSpend.settled.receipt.billedAmount);
    expect(Number(botSpend.settled.receipt.billedAmount)).toBeGreaterThan(0);

    // The bot paid from its OWN balance …
    expect(botSpend.reserved.reservation.billingAccountId).toBe(bot);
    const [receipt] = await getDb()
      .select({ accountId: usageReceipts.accountId })
      .from(usageReceipts)
      .where(eq(usageReceipts.id, botSpend.settled.receipt.receiptId));
    expect(receipt.accountId).toBe(bot);

    // … and its owner's money did not move.
    const ownerBalance = await getAccountBalance(getDb(), owner, 'USD');
    expect(Number(ownerBalance?.purchasedBalance)).toBe(0);
    expect(Number(ownerBalance?.reservedBalance)).toBe(0);

    const botBalance = await getAccountBalance(getDb(), bot, 'USD');
    const personBalance = await getAccountBalance(getDb(), person, 'USD');
    expect(botBalance?.purchasedBalance).toBe(personBalance?.purchasedBalance);
  });
});
