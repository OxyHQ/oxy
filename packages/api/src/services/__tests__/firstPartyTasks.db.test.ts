/**
 * How long a first-party task root lives (`createFirstPartyTask`).
 *
 * A `request` root never outlives its requester, and it is CLAMPED to the requester's remaining
 * lifetime rather than refused: the caller cannot see the session binding's expiry, and a refusal
 * ("Task lifetime is out of range") cost Gemies every room member's task minted on a bearer near the
 * end of its life (2026-11-13). Real Postgres, real session, real requester validation.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { applications } from '../../db/schema/applications';
import { sessions } from '../../db/schema/sessions';
import { bindWorkloadIdentity } from '../workloadIdentityBinding.service';
import { createFirstPartyTask } from '../firstPartyTasks.service';
import sessionService from '../session.service';

const saved = { ...process.env };
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = 'task-lifetime-test-secret';
  process.env.REFRESH_TOKEN_SECRET = 'task-lifetime-refresh-test';
  process.env.DEVICE_ID_SALT = 'f'.repeat(48);
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const MINUTE = 60_000;

async function fixture() {
  const [owner, user, bot] = await insertAccountFixtures([{}, {}, { kind: 'bot' }]);
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Task lifetime',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: [],
      capabilities: [],
    })
    .returning();
  const { binding } = await bindWorkloadIdentity({
    applicationId: app.id,
    subject: `arn:aws:iam::237343248947:role/task-lifetime-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  const presenter = {
    authority: 'first_party' as const,
    applicationId: app.id,
    credentialId: binding.attestationId,
    ownerAccountId: owner.id,
    capabilities: [],
  };
  const session = await sessionService.createSession(user.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
  });
  /** The requester's session ends in `ms`: the bound Oxy holds and the caller cannot see. */
  const sessionEndsIn = async (ms: number) => {
    const at = new Date(Date.now() + ms);
    await getDb()
      .update(sessions)
      .set({ expiresAt: at })
      .where(eq(sessions.sessionId, session.sessionId));
    return at;
  };
  const create = (kind: 'request' | 'goal', lifetimeMs: number) =>
    createFirstPartyTask(
      {
        origin: { kind, id: randomUUID() },
        actor: { type: 'agent', accountId: bot.id },
        effectiveAccountId: user.id,
        expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
      },
      session.accessToken,
      presenter,
    );
  return { create, sessionEndsIn };
}

describe('a request task root', () => {
  it('is clamped to the requester’s remaining lifetime, not refused', async () => {
    const { create, sessionEndsIn } = await fixture();
    const sessionEnd = await sessionEndsIn(3 * MINUTE);

    const task = await create('request', 10 * MINUTE);

    expect(task.expiresAt.getTime()).toBeLessThanOrEqual(sessionEnd.getTime());
    expect(task.expiresAt.getTime()).toBeGreaterThan(Date.now() + 2 * MINUTE);
  });

  it('keeps the lifetime it asked for when the requester outlives it', async () => {
    const { create, sessionEndsIn } = await fixture();
    await sessionEndsIn(60 * MINUTE);
    const before = Date.now();

    const task = await create('request', 5 * MINUTE);

    expect(task.expiresAt.getTime() - before).toBeGreaterThanOrEqual(5 * MINUTE - 1000);
    expect(task.expiresAt.getTime() - before).toBeLessThanOrEqual(5 * MINUTE + 1000);
  });

  it('is still refused past its own fifteen-minute maximum or in the past', async () => {
    const { create } = await fixture();
    await expect(create('request', 16 * MINUTE)).rejects.toThrow('Task lifetime is out of range.');
    await expect(create('request', -MINUTE)).rejects.toThrow('Task lifetime is out of range.');
  });
});

describe('a durable goal root', () => {
  it('is not bound to the session that started it', async () => {
    const { create, sessionEndsIn } = await fixture();
    await sessionEndsIn(3 * MINUTE);
    const before = Date.now();

    const task = await create('goal', 24 * 60 * MINUTE);

    expect(task.expiresAt.getTime() - before).toBeGreaterThan(23 * 60 * MINUTE);
  });
});
