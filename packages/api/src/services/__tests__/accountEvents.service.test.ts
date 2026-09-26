/**
 * Account events for relying parties (OxyHQ/Mention#1169), against a REAL
 * Postgres: who is told, that the event commits exactly with the deletion, that
 * the token it carries verifies with the public SDK, and that the pull feed
 * serves each application only its own settled events from a cursor.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { OxyServer } from '@oxy.so/core/server';
import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { serviceTokenPublicJwks } from '../../config/serviceTokenSigning';
import { accountEventDeliveries, accountEvents } from '../../db/schema/accountEvents';
import { appGrants } from '../../db/schema/appGrants';
import { applications } from '../../db/schema/applications';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { archiveAccountForRetention } from '../accountFinancialHolds.service';
import { accountService } from '../account.service';
import * as accountEventsService from '../accountEvents.service';
import {
  ACCOUNT_EVENT_FEED_SETTLE_MS,
  listAccountEventsForApplication,
  recordAccountDeletedEvent,
  signAccountEventToken,
} from '../accountEvents.service';

jest.setTimeout(60_000);

const signingKey = generateKeyPairSync('ed25519');
const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.SERVICE_TOKEN_SIGNING_KEY_ID = 'account-events-test';
  process.env.SERVICE_TOKEN_PRIVATE_KEY = signingKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  delete process.env.SERVICE_TOKEN_PUBLIC_JWKS;
  await connectPostgres();
});

afterAll(async () => {
  process.env = savedEnv;
  await closePostgres();
});

afterEach(() => jest.restoreAllMocks());

async function seedUser(prefix = 'erased'): Promise<{ id: string; username: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb()
    .insert(users)
    .values({ username: `${prefix}-${suffix}`, email: `${prefix}-${suffix}@example.test` })
    .returning({ id: users.id, username: users.username });
  return { id: user.id, username: user.username! };
}

async function seedApp(
  ownerAccountId: string,
  values: Partial<typeof applications.$inferInsert> = {},
): Promise<string> {
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID().slice(0, 8)}`, ownerAccountId, ...values })
    .returning({ id: applications.id });
  return app.id;
}

/** A person, and the applications around them. */
async function seedWorld() {
  const owner = await seedUser('owner');
  const person = await seedUser();
  const firstParty = await seedApp(owner.id, { type: 'first_party', webhookUrl: 'https://mention.example/webhooks/oxy' });
  const granted = await seedApp(owner.id, { type: 'third_party' });
  const signedIn = await seedApp(owner.id, { type: 'third_party' });
  const stranger = await seedApp(owner.id, { type: 'third_party', webhookUrl: 'https://stranger.example/hook' });
  const suspendedFirstParty = await seedApp(owner.id, { type: 'first_party', status: 'suspended' });
  await getDb().insert(appGrants).values({ userId: person.id, applicationId: granted, scopes: ['openid'] });
  await getDb().insert(sessions).values({
    sessionId: `session-${randomUUID()}`,
    userId: person.id,
    applicationId: signedIn,
    deviceId: `device-${randomUUID()}`,
    deviceType: 'desktop',
    platform: 'web',
    accessToken: `access-${randomUUID()}`,
    refreshToken: `refresh-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  } as typeof sessions.$inferInsert);
  return { owner, person, firstParty, granted, signedIn, stranger, suspendedFirstParty };
}

async function recipientsOf(eventId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ applicationId: accountEventDeliveries.applicationId })
    .from(accountEventDeliveries)
    .where(eq(accountEventDeliveries.eventId, eventId));
  return rows.map((row) => row.applicationId);
}

describe('recordAccountDeletedEvent', () => {
  it('addresses first-party apps and the apps the person used, never a stranger app, and survives the account row', async () => {
    const world = await seedWorld();

    const recorded = await getDb().transaction(async (tx) => {
      const event = await recordAccountDeletedEvent(tx, {
        userId: world.person.id,
        username: world.person.username,
        retained: false,
      });
      await tx.delete(users).where(eq(users.id, world.person.id));
      return event;
    });

    const recipients = await recipientsOf(recorded.eventId);
    expect(recipients).toEqual(expect.arrayContaining([world.firstParty, world.granted, world.signedIn]));
    expect(recipients).not.toContain(world.stranger);
    expect(recipients).not.toContain(world.suspendedFirstParty);
    expect(recorded.recipients).toBe(recipients.length);

    const [event] = await getDb().select().from(accountEvents).where(eq(accountEvents.id, recorded.eventId));
    expect(event).toMatchObject({
      type: 'account.deleted',
      userId: world.person.id,
      username: world.person.username,
      retained: false,
    });
    // The account is gone; the announcement is not.
    expect(await getDb().select({ id: users.id }).from(users).where(eq(users.id, world.person.id))).toHaveLength(0);
  });

  it('leaves no event behind when the deletion rolls back', async () => {
    const world = await seedWorld();
    let eventId = '';

    await expect(getDb().transaction(async (tx) => {
      eventId = (await recordAccountDeletedEvent(tx, {
        userId: world.person.id,
        username: world.person.username,
        retained: false,
      })).eventId;
      throw new Error('delete failed after the event was written');
    })).rejects.toThrow('delete failed');

    expect(eventId).not.toBe('');
    expect(await getDb().select().from(accountEvents).where(eq(accountEvents.id, eventId))).toHaveLength(0);
    expect(await getDb().select().from(accountEvents).where(eq(accountEvents.userId, world.person.id))).toHaveLength(0);
  });

  it('commits with the retention archive, marked retained', async () => {
    const world = await seedWorld();

    await archiveAccountForRetention(world.person.id, {
      withinTransaction: async (tx) => {
        await recordAccountDeletedEvent(tx, {
          userId: world.person.id,
          username: world.person.username,
          retained: true,
        });
      },
    });

    const [row] = await getDb()
      .select({ accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, world.person.id));
    expect(row.accountStatus).toBe('archived');
    const events = await getDb().select().from(accountEvents).where(eq(accountEvents.userId, world.person.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ retained: true, username: world.person.username });
  });

  it('does not archive when the in-transaction work fails', async () => {
    const world = await seedWorld();

    await expect(archiveAccountForRetention(world.person.id, {
      withinTransaction: async () => {
        throw new Error('event write failed');
      },
    })).rejects.toThrow('event write failed');

    const [row] = await getDb()
      .select({ accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, world.person.id));
    expect(row.accountStatus).not.toBe('archived');
  });
});

describe('archiving a managed account (DELETE /accounts/:id)', () => {
  async function seedChannel(): Promise<{ id: string; username: string }> {
    const suffix = randomUUID().slice(0, 8);
    const [channel] = await getDb()
      .insert(users)
      .values({ username: `channel-${suffix}`, kind: 'channel' } as typeof users.$inferInsert)
      .returning({ id: users.id, username: users.username });
    return { id: channel.id, username: channel.username! };
  }

  it('records account.deleted, retained, with the archive, so relying parties erase the channel (Mention#1178)', async () => {
    const world = await seedWorld();
    const channel = await seedChannel();

    const archived = await accountService.archiveAccount(channel.id);

    expect(archived.accountStatus).toBe('archived');
    const events = await getDb().select().from(accountEvents).where(eq(accountEvents.userId, channel.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'account.deleted',
      userId: channel.id,
      username: channel.username,
      retained: true,
    });
    // First-party applications (Mention) are always told; a stranger app is not.
    const recipients = await recipientsOf(events[0].id);
    expect(recipients).toContain(world.firstParty);
    expect(recipients).not.toContain(world.stranger);
  });

  it('records no event for a personal account, which cannot be archived this way', async () => {
    const person = await seedUser('personal');

    await expect(accountService.archiveAccount(person.id)).rejects.toThrow('cannot be archived');

    expect(await getDb().select().from(accountEvents).where(eq(accountEvents.userId, person.id))).toHaveLength(0);
  });

  it('does not archive the account when the event cannot be recorded', async () => {
    const channel = await seedChannel();
    jest
      .spyOn(accountEventsService, 'recordAccountDeletedEvent')
      .mockRejectedValueOnce(new Error('event write failed'));

    await expect(accountService.archiveAccount(channel.id)).rejects.toThrow('event write failed');

    const [row] = await getDb()
      .select({ accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, channel.id));
    expect(row.accountStatus).toBe('active');
  });
});

describe('the signed token', () => {
  it('verifies with the public SDK against the published key set and carries the event', async () => {
    const world = await seedWorld();
    const recorded = await getDb().transaction((tx) => recordAccountDeletedEvent(tx, {
      userId: world.person.id,
      username: world.person.username,
      retained: false,
    }));
    const [event] = await getDb().select().from(accountEvents).where(eq(accountEvents.id, recorded.eventId));

    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ keys: serviceTokenPublicJwks() }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const token = signAccountEventToken(event, world.firstParty);
    const verified = await new OxyServer({ baseURL: 'https://api.oxy.test' })
      .accountEvents.verify(token, { audience: world.firstParty });

    expect(verified).toMatchObject({
      eventId: recorded.eventId,
      type: 'account.deleted',
      userId: world.person.id,
      username: world.person.username,
      retained: false,
      applicationId: world.firstParty,
    });
    // Addressed to one application: another cannot replay it as its own.
    await expect(new OxyServer({ baseURL: 'https://api.oxy.test' })
      .accountEvents.verify(token, { audience: world.granted })).rejects.toThrow('another application');
  });
});

describe('listAccountEventsForApplication', () => {
  async function deleteAccount(): Promise<{ eventId: string; firstParty: string; stranger: string }> {
    const world = await seedWorld();
    const recorded = await getDb().transaction(async (tx) => {
      const event = await recordAccountDeletedEvent(tx, {
        userId: world.person.id,
        username: world.person.username,
        retained: false,
      });
      await tx.delete(users).where(eq(users.id, world.person.id));
      return event;
    });
    return { eventId: recorded.eventId, firstParty: world.firstParty, stranger: world.stranger };
  }

  const settled = () => new Date(Date.now() + ACCOUNT_EVENT_FEED_SETTLE_MS + 1_000);

  it('holds back the unsettled tail so a cursor cannot skip an in-flight deletion', async () => {
    const { firstParty } = await deleteAccount();
    await expect(listAccountEventsForApplication(firstParty)).resolves.toEqual({ events: [], nextCursor: null });
  });

  it('serves only the caller application its own events, oldest first, from a cursor', async () => {
    const first = await deleteAccount();
    // A second deletion the first-party app is also told about, and a stranger
    // app that is told about neither.
    const second = await getDb().transaction(async (tx) => {
      const person = await seedUser();
      return recordAccountDeletedEvent(tx, { userId: person.id, username: person.username, retained: false });
    });

    const page = await listAccountEventsForApplication(first.firstParty, { limit: 1, now: settled() });
    expect(page.events.map((event) => event.eventId)).toEqual([first.eventId]);
    expect(page.events[0]).toMatchObject({ type: 'account.deleted', retained: false });
    expect(typeof page.events[0]!.token).toBe('string');
    expect(page.nextCursor).toBe(first.eventId);

    await expect(listAccountEventsForApplication(first.stranger, { now: settled() }))
      .resolves.toEqual({ events: [], nextCursor: null });

    // The second event went to every first-party app, including this one.
    const deliveries = await getDb()
      .select({ applicationId: accountEventDeliveries.applicationId })
      .from(accountEventDeliveries)
      .where(and(
        eq(accountEventDeliveries.eventId, second.eventId),
        inArray(accountEventDeliveries.applicationId, [first.firstParty]),
      ));
    expect(deliveries).toHaveLength(1);
    const next = await listAccountEventsForApplication(first.firstParty, { after: page.nextCursor!, now: settled() });
    expect(next.events.map((event) => event.eventId)).toEqual([second.eventId]);

    const drained = await listAccountEventsForApplication(first.firstParty, { after: second.eventId, now: settled() });
    expect(drained).toEqual({ events: [], nextCursor: second.eventId });
  });

  it('caps the page size', async () => {
    const { firstParty } = await deleteAccount();
    const page = await listAccountEventsForApplication(firstParty, { limit: 10_000, now: settled() });
    expect(page.events.length).toBeLessThanOrEqual(200);
  });
});
