import { eq, inArray } from 'drizzle-orm';

const mockTransportFetch = jest.fn();
const mockDispose = jest.fn();
const mockCreateServiceClient = jest.fn(() => ({
  fetch: mockTransportFetch,
  dispose: mockDispose,
}));
jest.mock('../../capabilities/inbox-service-client', () => ({
  inboxServiceClient: () => ({ createServiceClient: mockCreateServiceClient }),
  requiredInboxServiceClient: () => ({ createServiceClient: mockCreateServiceClient }),
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
    snippet: 'Could you reply by Friday?',
    folder: 'inbox' as const,
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
  it('delivers the unchanged event with stable idempotency through the exact shared Alia transport', async () => {
    const normalized = buildInboxMessageEvents(input())[0];
    mockTransportFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await deliverNormalizedAppEvent(normalized);
    expect(mockCreateServiceClient).toHaveBeenCalledWith({
      baseURL: 'https://api.alia.onl',
      audience: 'oxy-service:6a2f851751b784a86fd0e934',
    });
    expect(mockTransportFetch).toHaveBeenCalledWith(
      'https://api.alia.onl/webhooks/oxy',
      expect.objectContaining({
        headers: expect.objectContaining({ 'idempotency-key': normalized.eventId }),
        body: JSON.stringify(normalized),
      }),
    );
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
  it('releases its transport on a failed delivery without marking an event delivered', async () => {
    mockTransportFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(deliverNormalizedAppEvent(buildInboxMessageEvents(input())[0])).rejects.toThrow(
      '(503)',
    );
    expect(mockTransportFetch).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('rolls event insertion back with its surrounding domain transaction', async () => {
    const eventInput = input();
    await expect(
      getDb().transaction(async (transaction) => {
        await enqueueInboxMessageEvents(transaction, eventInput);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

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
