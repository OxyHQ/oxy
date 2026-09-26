/**
 * The account-event webhook push (OxyHQ/Mention#1169), against a REAL
 * Postgres: signed delivery, retry with backoff, dead-lettering, the lease, and
 * that an acknowledged delivery is never sent again. The HTTP hop is injected;
 * the real one goes through `safeFetch`, whose SSRF guard refuses loopback.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { OxyServer } from '@oxy.so/core/server';
import { SsrfRejection } from '@oxy.so/core/server';
import { and, eq, ne } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { serviceTokenPublicJwks } from '../../config/serviceTokenSigning';
import { accountEventDeliveries } from '../../db/schema/accountEvents';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { recordAccountDeletedEvent } from '../accountEvents.service';
import {
  ACCOUNT_EVENT_WEBHOOK_MAX_ATTEMPTS,
  accountEventBackoffMs,
  runAccountEventWebhookBatch,
  type AccountEventWebhookRequest,
} from '../accountEventWebhook.worker';

jest.setTimeout(60_000);

const signingKey = generateKeyPairSync('ed25519');
const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.SERVICE_TOKEN_SIGNING_KEY_ID = 'account-events-worker-test';
  process.env.SERVICE_TOKEN_PRIVATE_KEY = signingKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  delete process.env.SERVICE_TOKEN_PUBLIC_JWKS;
  await connectPostgres();
});

afterAll(async () => {
  process.env = savedEnv;
  await closePostgres();
});

afterEach(() => jest.restoreAllMocks());

/**
 * A deletion with one recipient under test. Other suites' first-party apps are
 * recipients too, so every assertion is scoped to `applicationId`, and each
 * batch is fed a `deliver` that answers for that app and leaves others pending.
 */
async function seedDeletion(webhookUrl: string | null) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb()
    .insert(users)
    .values({ username: `hook-owner-${suffix}`, email: `hook-owner-${suffix}@example.test` })
    .returning({ id: users.id });
  const [person] = await getDb()
    .insert(users)
    .values({ username: `hook-person-${suffix}`, email: `hook-person-${suffix}@example.test` })
    .returning({ id: users.id, username: users.username });
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `Hook ${suffix}`, ownerAccountId: owner.id, type: 'first_party', webhookUrl })
    .returning({ id: applications.id });
  const recorded = await getDb().transaction(async (tx) => {
    const event = await recordAccountDeletedEvent(tx, {
      userId: person.id,
      username: person.username,
      retained: false,
    });
    await tx.delete(users).where(eq(users.id, person.id));
    return event;
  });
  // Park every OTHER app's delivery for this event, so batches claim only ours.
  await getDb()
    .update(accountEventDeliveries)
    .set({ deliveredAt: new Date() })
    .where(and(
      eq(accountEventDeliveries.eventId, recorded.eventId),
      ne(accountEventDeliveries.applicationId, app.id),
    ));
  return { eventId: recorded.eventId, applicationId: app.id, personId: person.id, username: person.username };
}

async function delivery(eventId: string, applicationId: string) {
  const [row] = await getDb()
    .select()
    .from(accountEventDeliveries)
    .where(and(
      eq(accountEventDeliveries.eventId, eventId),
      eq(accountEventDeliveries.applicationId, applicationId),
    ));
  return row!;
}

/** Only ours is due; drain until our delivery has been attempted. */
async function runFor(
  _applicationId: string,
  deliver: (request: AccountEventWebhookRequest) => Promise<number>,
  now?: () => Date,
) {
  return runAccountEventWebhookBatch({
    ownerId: `test-${randomUUID()}`,
    batchSize: 500,
    deliver,
    now,
  });
}

describe('account event webhook worker', () => {
  it('POSTs a token that verifies with the public SDK and marks the delivery delivered', async () => {
    const seeded = await seedDeletion('https://rp.example/webhooks/oxy');
    const requests: AccountEventWebhookRequest[] = [];

    await runFor(seeded.applicationId, async (request) => {
      requests.push(request);
      return 202;
    });

    const ours = requests.filter((request) => request.url === 'https://rp.example/webhooks/oxy' && request.eventId === seeded.eventId);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.eventType).toBe('account.deleted');

    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ keys: serviceTokenPublicJwks() }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const verified = await new OxyServer({ baseURL: 'https://api.oxy.test' })
      .accountEvents.verify(ours[0]!.token, { audience: seeded.applicationId });
    expect(verified).toMatchObject({
      eventId: seeded.eventId,
      userId: seeded.personId,
      username: seeded.username,
    });

    const row = await delivery(seeded.eventId, seeded.applicationId);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastStatus).toBe(202);

    // Acknowledged means done: a later batch never sends it again.
    const again: AccountEventWebhookRequest[] = [];
    await runFor(seeded.applicationId, async (request) => {
      again.push(request);
      return 202;
    });
    expect(again.filter((request) => request.eventId === seeded.eventId && request.url === 'https://rp.example/webhooks/oxy')).toHaveLength(0);
  });

  it('retries a non-2xx with exponential backoff, re-sending the same event id', async () => {
    const seeded = await seedDeletion('https://rp.example/flaky');
    const sent: string[] = [];
    const deliver = async (request: AccountEventWebhookRequest) => {
      if (request.url === 'https://rp.example/flaky') sent.push(request.eventId);
      return request.url === 'https://rp.example/flaky' ? 503 : 202;
    };

    let clock = new Date();
    await runFor(seeded.applicationId, deliver, () => clock);
    let row = await delivery(seeded.eventId, seeded.applicationId);
    expect(row).toMatchObject({ attempts: 1, lastStatus: 503, deliveredAt: null, failedAt: null, claimedBy: null });
    expect(row.nextAttemptAt.getTime()).toBe(clock.getTime() + accountEventBackoffMs(1));

    // Not due yet: nothing is sent.
    await runFor(seeded.applicationId, deliver, () => clock);
    expect(sent).toEqual([seeded.eventId]);

    clock = new Date(row.nextAttemptAt.getTime() + 1);
    await runFor(seeded.applicationId, deliver, () => clock);
    row = await delivery(seeded.eventId, seeded.applicationId);
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt.getTime()).toBe(clock.getTime() + accountEventBackoffMs(2));
    expect(sent).toEqual([seeded.eventId, seeded.eventId]);
  });

  it('dead-letters after the attempt limit and records why', async () => {
    const seeded = await seedDeletion('https://rp.example/down');
    await getDb()
      .update(accountEventDeliveries)
      .set({ attempts: ACCOUNT_EVENT_WEBHOOK_MAX_ATTEMPTS - 1 })
      .where(and(
        eq(accountEventDeliveries.eventId, seeded.eventId),
        eq(accountEventDeliveries.applicationId, seeded.applicationId),
      ));

    const result = await runFor(seeded.applicationId, async (request) => {
      if (request.url === 'https://rp.example/down') throw new Error('connect ECONNREFUSED');
      return 202;
    });

    const row = await delivery(seeded.eventId, seeded.applicationId);
    expect(row.failedAt).not.toBeNull();
    expect(row.attempts).toBe(ACCOUNT_EVENT_WEBHOOK_MAX_ATTEMPTS);
    expect(row.lastError).toContain('ECONNREFUSED');
    expect(result.deadLettered).toBeGreaterThanOrEqual(1);
  });

  it('records an SSRF refusal as a failed attempt instead of throwing the batch', async () => {
    const seeded = await seedDeletion('https://rp.example/internal');
    await runFor(seeded.applicationId, async (request) => {
      if (request.url === 'https://rp.example/internal') throw new SsrfRejection('resolves to a private address');
      return 202;
    });
    const row = await delivery(seeded.eventId, seeded.applicationId);
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('SSRF guard');
    expect(row.failedAt).toBeNull();
  });

  it('closes the push path for an application with no webhook, leaving the event to the pull feed', async () => {
    const seeded = await seedDeletion(null);
    const deliver = jest.fn(async () => 202);
    await runFor(seeded.applicationId, deliver);
    const row = await delivery(seeded.eventId, seeded.applicationId);
    expect(row.failedAt).not.toBeNull();
    expect(row.lastError).toContain('pull feed');
    expect(row.attempts).toBe(0);
  });

  it('does not steal a delivery another worker holds under a live lease', async () => {
    const seeded = await seedDeletion('https://rp.example/leased');
    await getDb()
      .update(accountEventDeliveries)
      .set({ claimedAt: new Date(), claimedBy: 'other-worker' })
      .where(and(
        eq(accountEventDeliveries.eventId, seeded.eventId),
        eq(accountEventDeliveries.applicationId, seeded.applicationId),
      ));
    const deliver = jest.fn(async () => 202);
    await runFor(seeded.applicationId, deliver);
    const row = await delivery(seeded.eventId, seeded.applicationId);
    expect(row.deliveredAt).toBeNull();
    expect(row.claimedBy).toBe('other-worker');
  });

  it('backs off exponentially and caps at six hours', () => {
    expect(accountEventBackoffMs(1)).toBe(60_000);
    expect(accountEventBackoffMs(2)).toBe(120_000);
    expect(accountEventBackoffMs(3)).toBe(240_000);
    expect(accountEventBackoffMs(ACCOUNT_EVENT_WEBHOOK_MAX_ATTEMPTS)).toBe(6 * 60 * 60 * 1000);
  });
});
