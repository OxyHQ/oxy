/**
 * The Inbox read API against its published wire contract, on a REAL Postgres.
 *
 * `emailWireContract.ts` proves the DTO TYPES serialise to the contract; this
 * proves the VALUES do — every read a client parses is JSON round-tripped and
 * handed to the same `@oxy.so/contracts` schema the client uses, with the rows
 * that once broke a client in it: an attachment without a Content-ID
 * (`contentId: null`), a card whose extracted fields are unknown, a contact
 * without a company.
 *
 * `.parse`, not `.safeParse`: a failure must name the field.
 */

const mockUploadFileDirect = jest.fn();

jest.mock('../assetServiceSingleton', () => ({
  assetService: {
    uploadFileDirect: (...args: unknown[]) => mockUploadFileDirect(...args),
    linkFile: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({
  aiLabelingService: { enqueueClassification: jest.fn().mockReturnValue(true) },
}));
jest.mock('../cardExtraction.service', () => ({
  cardExtractionService: { extractAndUpdate: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../smtp.outbound', () => ({
  __esModule: true,
  smtpOutbound: { send: jest.fn() },
  default: { send: jest.fn() },
}));
jest.mock('../emailPushDelivery.service', () => ({
  sendInboxEmailPush: jest.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  emailBundledInboxSchema,
  emailContactSchema,
  emailFilterSchema,
  emailLabelSchema,
  emailMailboxSchema,
  emailMessageSchema,
} from '@oxy.so/contracts';
import { z } from 'zod';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

/** Exactly what a client receives. */
const overTheWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

let user: { id: string; username: string };
let ampMessageId: string;
let plainMessageId: string;

beforeAll(async () => {
  await connectPostgres();

  const username = `contract${unique().slice(0, 10)}`;
  const [row] = await getDb().insert(users).values({ username, color: 'teal' }).returning({ id: users.id });
  user = { id: row.id, username };

  const [file] = await getDb()
    .insert(files)
    .values({
      sha256: unique(),
      size: 12,
      mime: 'application/pdf',
      ext: 'pdf',
      storageKey: `assets/${unique()}`,
      originalName: 'invoice.pdf',
      ownerUserId: user.id,
    })
    .returning({ id: files.id });
  mockUploadFileDirect.mockResolvedValue({ id: file.id, originalName: 'invoice.pdf', mime: 'application/pdf', size: 12 });

  // An attachment with no Content-ID: the shape that vanished from the inbox.
  const withAttachment = await emailService.storeIncomingMessage({
    recipientUsername: username,
    from: { address: 'communications@ramp.com' },
    to: [{ address: `${username}@oxy.so` }],
    subject: '977687 is your Ramp sign-in code',
    text: 'Use this code',
    messageId: `<code-${unique()}@ramp.com>`,
    date: new Date('2026-09-27T05:56:22.000Z'),
    headers: {},
    attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') }],
    rawSize: 100,
  });
  ampMessageId = withAttachment.id;

  const plain = await emailService.storeIncomingMessage({
    recipientUsername: username,
    from: { name: 'Ada', address: 'ada@example.com' },
    to: [{ address: `${username}@oxy.so` }],
    subject: 'Receipt',
    text: 'Thanks',
    messageId: `<receipt-${unique()}@example.com>`,
    date: new Date('2026-09-26T05:56:22.000Z'),
    headers: {},
    rawSize: 100,
  });
  plainMessageId = plain.id;

  // A card whose extracted fields are all unknown.
  await getDb().update(messages).set({ cardType: 'purchase' }).where(eq(messages.id, plainMessageId));
});

afterAll(async () => {
  await closePostgres();
});

async function inbox() {
  const mailbox = await emailService.getMailboxBySpecialUse(user.id, '\\Inbox');
  if (!mailbox) throw new Error('no inbox');
  return mailbox.id;
}

describe('Inbox read API honours @oxy.so/contracts', () => {
  it('lists messages, including one with an attachment that has no Content-ID', async () => {
    const page = await emailService.listMessages(user.id, await inbox(), { limit: 50 });
    const parsed = z.array(emailMessageSchema).parse(overTheWire(page.data));

    const coded = parsed.find((m) => m.id === ampMessageId);
    expect(coded?.attachments).toEqual([
      expect.objectContaining({ name: 'invoice.pdf', contentId: null, isInline: false }),
    ]);
    const carded = parsed.find((m) => m.id === plainMessageId);
    expect(carded?.card).toEqual({ type: 'purchase', data: null, confidence: null, extractedAt: null });
  });

  it('reads one message and its thread, bodies included', async () => {
    const one = await emailService.getMessage(user.id, ampMessageId);
    expect(emailMessageSchema.parse(overTheWire(one)).text).toBe('Use this code');

    const thread = await emailService.getThread(user.id, ampMessageId);
    z.array(emailMessageSchema).parse(overTheWire(thread));
  });

  it('searches', async () => {
    const result = await emailService.searchMessages(user.id, 'Ramp', {});
    z.array(emailMessageSchema).parse(overTheWire(result.data));
  });

  it('bundles the inbox', async () => {
    const bundled = await emailService.listBundledMessages(user.id, await inbox(), { limit: 50, offset: 0 });
    emailBundledInboxSchema.parse(overTheWire(bundled));
  });

  it('lists mailboxes, labels and filters', async () => {
    z.array(emailMailboxSchema).parse(overTheWire(await emailService.listMailboxes(user.id)));
    await emailService.createLabel(user.id, `Mine ${unique().slice(0, 6)}`, '#123456');
    z.array(emailLabelSchema).parse(overTheWire(await emailService.listLabels(user.id)));
    await emailService.createFilter(user.id, {
      name: 'Ramp',
      enabled: true,
      matchAll: true,
      conditions: [{ field: 'from', operator: 'contains', value: 'ramp.com' }],
      actions: [{ type: 'star' }],
    });
    z.array(emailFilterSchema).parse(overTheWire(await emailService.listFilters(user.id)));
  });

  it('lists a contact without a company or notes', async () => {
    await emailService.createContact(user.id, { name: 'Ada', email: `ada-${unique()}@example.com` });
    const { data } = await emailService.listContacts(user.id);
    const parsed = z.array(emailContactSchema).parse(overTheWire(data));
    expect(parsed[0]).toEqual(expect.objectContaining({ company: null, notes: null }));
  });
});
