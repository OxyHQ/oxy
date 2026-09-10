import { eq, inArray } from 'drizzle-orm';

const mockGetServiceToken = jest.fn();
const mockInvalidateServiceToken = jest.fn();
jest.mock('../../capabilities/inbox-service-client', () => ({
  inboxServiceClient: () => ({
    getServiceToken: (...args: unknown[]) => mockGetServiceToken(...args),
    invalidateServiceToken: (...args: unknown[]) => mockInvalidateServiceToken(...args),
  }),
  requiredInboxServiceClient: () => ({
    getServiceToken: (...args: unknown[]) => mockGetServiceToken(...args),
    invalidateServiceToken: (...args: unknown[]) => mockInvalidateServiceToken(...args),
  }),
}));

import {
  buildInboxMessageEvents,
  enqueueInboxMessageEvents,
} from '../../capabilities/inbox.events';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { normalizedAppEventOutbox } from '../../db/schema/normalizedAppEventOutbox';
import {
  deliverNormalizedAppEvent,
  runNormalizedEventOutboxBatch,
} from '../normalizedAppEventOutbox.worker';

let sequence = 0;

function input() {
  sequence += 1;
  return {
    ownerAccountId: `account-${process.pid}-${sequence}`,
    mailboxId: `mailbox-${process.pid}-${sequence}`,
    messageId: `message-${process.pid}-${sequence}`,
    senderAddress: 'person@example.com',
    subject: 'Could you reply?',
    headers: {},
    receivedAt: new Date('2026-09-03T10:00:00.000Z'),
  };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await closePostgres();
});

describe('normalized Inbox event outbox', () => {
  it('delivers with service bearer auth and eventId idempotency, refreshing once on 401', async () => {
    const eventInput = input();
    const normalized = buildInboxMessageEvents(eventInput)[0];
    mockGetServiceToken.mockResolvedValueOnce('expired-token').mockResolvedValueOnce('fresh-token');
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await deliverNormalizedAppEvent(normalized);

    expect(mockInvalidateServiceToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/webhooks\/oxy$/),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer fresh-token',
          'idempotency-key': normalized.eventId,
        }),
      }),
    );
  });

  it('rolls event insertion back with its surrounding domain transaction', async () => {
    const eventInput = input();
    await expect(getDb().transaction(async (transaction) => {
      await enqueueInboxMessageEvents(transaction, eventInput);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');

    const rows = await getDb()
      .select({ id: normalizedAppEventOutbox.id })
      .from(normalizedAppEventOutbox)
      .where(eq(normalizedAppEventOutbox.eventId, `${eventInput.messageId}:new_email`));
    expect(rows).toHaveLength(0);
  });

  it('deduplicates enqueue and retries a failed delivery by eventId', async () => {
    const eventInput = input();
    await enqueueInboxMessageEvents(getDb(), eventInput);
    await enqueueInboxMessageEvents(getDb(), eventInput);

    const eventIds = [
      `${eventInput.messageId}:new_email`,
      `${eventInput.messageId}:email_needs_reply`,
    ];
    const inserted = await getDb()
      .select({ eventId: normalizedAppEventOutbox.eventId })
      .from(normalizedAppEventOutbox)
      .where(inArray(normalizedAppEventOutbox.eventId, eventIds));
    expect(inserted.map(({ eventId }) => eventId).sort()).toEqual([...eventIds].sort());

    await runNormalizedEventOutboxBatch({
      ownerId: 'inbox-worker-failing',
      batchSize: 500,
      deliver: async (event) => {
        if (eventIds.includes(event.eventId)) throw new Error('temporary outage');
      },
    });

    const failed = await getDb()
      .select({ processedAt: normalizedAppEventOutbox.processedAt })
      .from(normalizedAppEventOutbox)
      .where(inArray(normalizedAppEventOutbox.eventId, eventIds));
    expect(failed.every(({ processedAt }) => processedAt === null)).toBe(true);

    const delivered: string[] = [];
    await runNormalizedEventOutboxBatch({
      ownerId: 'inbox-worker-retry',
      batchSize: 500,
      leaseMs: 0,
      deliver: async (event) => {
        if (eventIds.includes(event.eventId)) delivered.push(event.eventId);
      },
    });

    expect(delivered.sort()).toEqual([...eventIds].sort());
    const processed = await getDb()
      .select({ processedAt: normalizedAppEventOutbox.processedAt })
      .from(normalizedAppEventOutbox)
      .where(inArray(normalizedAppEventOutbox.eventId, eventIds));
    expect(processed.every(({ processedAt }) => processedAt instanceof Date)).toBe(true);
  });
});
