/**
 * Card extraction, against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **The card must land in FOUR COLUMNS, and a dot path would land nowhere.**
 * The Mongo write was `$set: { card: { type, data, confidence, extractedAt } }`;
 * `messages` spells that as `card_type` / `card_data` / `card_confidence` /
 * `card_extracted_at`. Drizzle keys `set()` by column PROPERTY and silently
 * ignores a key naming no column, so the transliteration `set({ card: {…} })` —
 * or any `'card.type'` spelling — writes NOTHING, throws NOTHING, and logs
 * `Card extraction complete`. Every case below reads the stored row back rather
 * than asserting on the shape of a call.
 *
 * The second guarantee is the projection. `messages.text` is PROTECTED
 * (`schema/protectedColumns.ts`) and the extractor needs it, so it is named
 * explicitly; `html` was in the Mongo projection, was read by NOTHING, and is
 * another protected body — it is no longer fetched at all. `attachments` became
 * a child table and only its emptiness was ever used, so the projection asks an
 * `EXISTS` rather than loading rows.
 *
 * ## Why every case reloads the module
 *
 * `ALIA_API_KEY` is read at module load, so the service cannot be configured
 * after import. Each case therefore builds a fresh module registry — including a
 * fresh `config/postgres`, which the loaded service resolves `getDb()` through.
 * Seeding and verification go through this file's OWN connection.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { mailboxes } from '../../db/schema/mailboxes';
import { messageAttachments } from '../../db/schema/messageAttachments';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';

interface LoadedService {
  extractAndUpdate: (userId: string, messageId: string) => Promise<void>;
}

interface Loaded {
  service: LoadedService;
  axiosPost: jest.Mock;
  close: () => Promise<void>;
}

/** The `user` half of the prompt the service posted. */
function promptOf(axiosPost: jest.Mock): string {
  const payload = axiosPost.mock.calls[0]?.[1] as
    | { messages?: { role: string; content: string }[] }
    | undefined;
  return payload?.messages?.find((entry) => entry.role === 'user')?.content ?? '';
}

/** An upstream reply carrying `extraction` as the model's JSON answer. */
function aiReply(extraction: unknown): { data: unknown } {
  return { data: { choices: [{ message: { content: JSON.stringify(extraction) } }] } };
}

async function loadService(): Promise<Loaded> {
  jest.resetModules();
  process.env.ALIA_API_KEY = 'test-alia-key';

  jest.doMock('../../utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  const axiosPost = jest.fn();
  jest.doMock('axios', () => ({ __esModule: true, default: { post: axiosPost } }));

  const postgres = await import('../../config/postgres');
  await postgres.connectPostgres();
  const { cardExtractionService } = await import('../cardExtraction.service');

  return {
    service: cardExtractionService as unknown as LoadedService,
    axiosPost,
    close: () => postgres.closePostgres(),
  };
}

let USER_ID = '';
let STRANGER_ID = '';
let MAILBOX_ID = '';
let loaded: Loaded | null = null;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertMessage(
  options: { userId?: string; text?: string | null; subject?: string; date?: Date } = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId: options.userId ?? USER_ID,
      mailboxId: MAILBOX_ID,
      messageId: `<${randomUUID()}@oxy.so>`,
      fromName: 'Airline',
      fromAddress: 'noreply@airline.example',
      subject: options.subject ?? 'Your flight is confirmed',
      text: options.text === undefined ? 'Booking reference ABC123, departing 10:00.' : options.text,
      size: 512,
      date: options.date ?? new Date('2026-03-04T05:06:07.000Z'),
    })
    .returning({ id: messages.id });
  return row.id;
}

async function attachFile(messageId: string): Promise<void> {
  const db = getDb();
  const [file] = await db
    .insert(files)
    .values({
      sha256: randomUUID().replace(/-/g, '').repeat(2),
      size: 1024,
      mime: 'application/pdf',
      ext: 'pdf',
      ownerUserId: USER_ID,
      storageKey: `seed/${randomUUID()}`,
    })
    .returning({ id: files.id });
  await db.insert(messageAttachments).values({
    messageId,
    ord: 0,
    fileId: file.id,
    name: 'ticket.pdf',
    contentType: 'application/pdf',
    size: 1024,
  });
}

/** The card + highlight columns as STORED. */
async function storedCard(messageId: string) {
  const [row] = await getDb()
    .select({
      cardType: messages.cardType,
      cardData: messages.cardData,
      cardConfidence: messages.cardConfidence,
      cardExtractedAt: messages.cardExtractedAt,
      highlights: messages.highlights,
    })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  USER_ID = await insertUser();
  STRANGER_ID = await insertUser();
  const [mailbox] = await getDb()
    .insert(mailboxes)
    .values({ userId: USER_ID, name: 'Inbox', path: `Inbox-${randomUUID()}` })
    .returning({ id: mailboxes.id });
  MAILBOX_ID = mailbox.id;
});

afterEach(async () => {
  await loaded?.close();
  loaded = null;
  jest.clearAllMocks();
});

describe('storing an extracted card', () => {
  it('writes all FOUR card columns, not a sub-document', async () => {
    // THE guarantee: a dotted or nested key names no column, so drizzle drops it
    // and the service still logs success.
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(
      aiReply({
        card: {
          type: 'trip',
          data: { airline: 'Oxy Air', confirmationCode: 'ABC123' },
          confidence: 0.93,
        },
        highlights: [],
      })
    );

    const before = Date.now();
    await loaded.service.extractAndUpdate(USER_ID, messageId);

    const stored = await storedCard(messageId);
    expect(stored.cardType).toBe('trip');
    expect(stored.cardData).toEqual({ airline: 'Oxy Air', confirmationCode: 'ABC123' });
    expect(stored.cardConfidence).toBeCloseTo(0.93, 5);
    expect(stored.cardExtractedAt).toBeInstanceOf(Date);
    expect(stored.cardExtractedAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stores highlights as a jsonb array', async () => {
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(
      aiReply({
        card: null,
        highlights: [
          { type: 'confirmation', value: 'ABC123', label: 'Booking ref' },
          { type: 'date', value: '2026-03-04', label: 'Departs' },
        ],
      })
    );

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    const stored = await storedCard(messageId);
    expect(stored.highlights).toEqual([
      { type: 'confirmation', value: 'ABC123', label: 'Booking ref' },
      { type: 'date', value: '2026-03-04', label: 'Departs' },
    ]);
    // No card was extracted, so the four card columns stay NULL together —
    // `messages_card_complete_check` admits nothing else.
    expect(stored.cardType).toBeNull();
    expect(stored.cardData).toBeNull();
    expect(stored.cardConfidence).toBeNull();
    expect(stored.cardExtractedAt).toBeNull();
  });

  it('discards a card the model is not confident about', async () => {
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(
      aiReply({ card: { type: 'bill', data: { biller: 'X' }, confidence: 0.4 }, highlights: [] })
    );

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    expect((await storedCard(messageId)).cardType).toBeNull();
  });

  it('discards a card type the column would reject', async () => {
    // The accepted set is the schema's own tuple, so the parser and the CHECK
    // constraint cannot disagree.
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(
      aiReply({ card: { type: 'invitation', data: {}, confidence: 0.99 }, highlights: [] })
    );

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    expect((await storedCard(messageId)).cardType).toBeNull();
  });

  it('writes nothing at all when the model finds neither a card nor a highlight', async () => {
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply({ card: null, highlights: [] }));

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    const stored = await storedCard(messageId);
    expect(stored.cardType).toBeNull();
    expect(stored.highlights).toEqual([]);
  });

  it('leaves another account\'s message untouched', async () => {
    // The lookup is scoped by `(id, user_id)`, so from the stranger's side the
    // message does not exist — no upstream call, no write.
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(
      aiReply({ card: { type: 'trip', data: {}, confidence: 0.99 }, highlights: [] })
    );

    await loaded.service.extractAndUpdate(STRANGER_ID, messageId);

    expect(loaded.axiosPost).not.toHaveBeenCalled();
    expect((await storedCard(messageId)).cardType).toBeNull();
  });
});

describe('what the extractor is given', () => {
  it('sends the message body — the PROTECTED `text` column really is fetched', async () => {
    const messageId = await insertMessage({ text: 'Booking reference ZZZ999.' });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply({ card: null, highlights: [] }));

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    const prompt = promptOf(loaded.axiosPost);
    expect(prompt).toContain('Booking reference ZZZ999.');
    expect(prompt).toContain('Your flight is confirmed');
    expect(prompt).toContain('Airline <noreply@airline.example>');
  });

  it('reports the message date as an ISO-8601 instant', async () => {
    // `timestamptz` + `mode: 'date'` hands back a `Date`, so the Mongo-era
    // `instanceof Date ? … : String(…)` branch is gone. If the read ever came
    // back through `db.execute`, this would be the raw
    // `2026-03-04 05:06:07+00` string instead.
    const messageId = await insertMessage({ date: new Date('2026-03-04T05:06:07.000Z') });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply({ card: null, highlights: [] }));

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    expect(promptOf(loaded.axiosPost)).toContain('Date: 2026-03-04T05:06:07.000Z');
  });

  it.each([
    ['false when the message has no attachment rows', false, false],
    ['true when it has one', true, true],
  ])('reports hasAttachments %s', async (_label, attach, expected) => {
    const messageId = await insertMessage();
    if (attach) await attachFile(messageId);
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply({ card: null, highlights: [] }));

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    expect(promptOf(loaded.axiosPost)).toContain(`Has attachments: ${expected}`);
  });

  it('does not call the model for a message with no body and no subject', async () => {
    const messageId = await insertMessage({ text: null, subject: '' });
    loaded = await loadService();

    await loaded.service.extractAndUpdate(USER_ID, messageId);

    expect(loaded.axiosPost).not.toHaveBeenCalled();
  });
});
