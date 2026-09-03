/**
 * AI email labeling, against a REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **`$addToSet` is not `||`.** Mongo's operator appended each DISTINCT value
 * that the array did not already hold; `messages.labels` is a native `text[]`
 * now, and a plain concatenation would duplicate a label the message already
 * carries — silently, on a column the inbox renders directly. The rebuild is
 * pinned from three directions here: an existing label is not re-added, the
 * existing ORDER survives, and duplicates inside one classifier answer collapse.
 *
 * The second guarantee is the read: `messages.text` is a PROTECTED column
 * (`schema/protectedColumns.ts`) and the classifier needs it, so it is named
 * explicitly in the projection. `sends the message body to the classifier` is
 * what proves the opt-in actually reaches the body rather than quietly handing
 * the model an empty string — which would produce no labels, no error, and a
 * completely plausible-looking "the model found nothing".
 *
 * ## Why every case reloads the module
 *
 * `AI_LABELING_CONFIG` is read at module load, so the service cannot be
 * reconfigured after import. Each case therefore builds a
 * fresh module registry — including a fresh `config/postgres`, which the loaded
 * service resolves `getDb()` through and which must therefore be connected
 * inside that registry. Seeding and verification go through this file's OWN
 * connection, so a case that writes nothing is visible as an unchanged row
 * rather than as a mock that was not called.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { SYSTEM_LABELS } from '../../constants/systemLabels';
import { labels as labelsTable } from '../../db/schema/labels';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';

/** Milliseconds a queue assertion waits before giving up. */
const QUEUE_DEADLINE_MS = 5000;
/** Milliseconds of quiet used to show a bound is not merely slow to be crossed. */
const QUIET_MS = 150;

/**
 * Wait until `predicate` holds.
 *
 * A fixed number of microtask flushes was enough while the queue's DB lookups
 * were instantly-resolving mocks; they are real round trips now, so a fixed
 * flush count is a race that reads as "the job never started". Failing with the
 * label rather than on the caller's own assertion keeps the diagnosis honest.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + QUEUE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Let anything already in flight finish, so an upper bound means something. */
async function quiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
}

interface AiLabelingConfigOverrides {
  maxConcurrent?: number;
  maxQueueSize?: number;
  maxBodyChars?: number;
}

interface LoadedService {
  classifyAndLabel: (userId: string, messageId: string) => Promise<void>;
  enqueueClassification: (userId: string, messageId: string) => boolean;
}

interface Loaded {
  service: LoadedService;
  axiosPost: jest.Mock;
  close: () => Promise<void>;
}

/** The `user` half of the prompt the service posted on call `index`. */
function promptOf(axiosPost: jest.Mock, index = 0): string {
  const payload = axiosPost.mock.calls[index]?.[0] as
    | { messages?: { role: string; content: Array<{ type: string; text: string }> }[] }
    | undefined;
  return payload?.messages?.find((entry) => entry.role === 'user')?.content[0]?.text ?? '';
}

/** An upstream reply carrying `labels` as the model's JSON array answer. */
function aiReply(labels: string[]): { text: string } {
  return { text: JSON.stringify(labels) };
}

async function loadService(overrides: AiLabelingConfigOverrides = {}): Promise<Loaded> {
  jest.resetModules();
  jest.doMock('../../config/email.config', () => ({
    AI_LABELING_CONFIG: {
      enabled: true,
      timeout: 10000,
      maxBodyChars: 1500,
      maxConcurrent: 2,
      maxQueueSize: 100,
      ...overrides,
    },
  }));
  jest.doMock('../../utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  const axiosPost = jest.fn();
  jest.doMock('../inboxInference.service', () => ({
    executeInboxPointInference: axiosPost,
    inboxCompletionText: (completion: { text: string }) => completion.text,
  }));

  // The reloaded service resolves `getDb()` through a reloaded
  // `config/postgres`, which therefore has to be connected in this registry.
  const postgres = await import('../../config/postgres');
  await postgres.connectPostgres();
  const { aiLabelingService } = await import('../aiLabeling.service');

  return {
    service: aiLabelingService as unknown as LoadedService,
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

async function insertMessage(options: {
  userId?: string;
  labels?: string[];
  text?: string;
  subject?: string;
} = {}): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId: options.userId ?? USER_ID,
      mailboxId: MAILBOX_ID,
      messageId: `<${randomUUID()}@oxy.so>`,
      fromName: 'Sender',
      fromAddress: 'sender@example.com',
      subject: options.subject ?? 'Quarterly invoice',
      text: options.text ?? 'The invoice for Q3 is attached.',
      size: 512,
      date: new Date(),
      labels: options.labels ?? [],
    })
    .returning({ id: messages.id });
  return row.id;
}

/** The labels a message currently carries, read straight from the table. */
async function storedLabels(messageId: string): Promise<string[]> {
  const [row] = await getDb()
    .select({ labels: messages.labels })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row.labels;
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

describe('the enablement gate', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('keeps AI labeling disabled unless explicitly enabled', async () => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AI_LABELING_ENABLED;

    const { AI_LABELING_CONFIG } = await import('../../config/email.config');

    expect(AI_LABELING_CONFIG.enabled).toBe(false);
  });

  it('enables AI labeling when AI_LABELING_ENABLED is set', async () => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.AI_LABELING_ENABLED = 'true';

    const { AI_LABELING_CONFIG } = await import('../../config/email.config');

    expect(AI_LABELING_CONFIG.enabled).toBe(true);
  });
});

describe('applying labels — the `$addToSet` port', () => {
  it('appends what the classifier chose, keeping the labels already there', async () => {
    const messageId = await insertMessage({ labels: ['Existing'] });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['Work']));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    // Order is part of the contract: existing entries first, in their existing
    // order, then the additions in the order the classifier returned them.
    expect(await storedLabels(messageId)).toEqual(['Existing', 'Work']);
  });

  it('does NOT re-add a label the message already carries', async () => {
    // The whole point of `$addToSet`. A plain `labels || incoming` stores
    // `['Work', 'Work']` with no error, on a column the inbox renders directly.
    const messageId = await insertMessage({ labels: ['Work'] });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['Work', 'Personal']));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    expect(await storedLabels(messageId)).toEqual(['Work', 'Personal']);
  });

  it('collapses duplicates inside one classifier answer', async () => {
    // `parseLabels` canonicalizes case, so `work` and `Work` both resolve to the
    // stored `Work` — `$addToSet` added it once and so must this.
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['Work', 'work', 'WORK']));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    expect(await storedLabels(messageId)).toEqual(['Work']);
  });

  it('preserves the existing order when several labels are appended', async () => {
    const messageId = await insertMessage({ labels: ['Zeta', 'Alpha'] });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['Personal', 'Work']));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    expect(await storedLabels(messageId)).toEqual(['Zeta', 'Alpha', 'Personal', 'Work']);
  });

  it('writes nothing when the classifier picks a label outside the offered list', async () => {
    const messageId = await insertMessage({ labels: ['Existing'] });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['NotAnOfferedLabel']));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    expect(loaded.axiosPost).toHaveBeenCalledTimes(1);
    expect(await storedLabels(messageId)).toEqual(['Existing']);
  });

  it('touches only the named message', async () => {
    const target = await insertMessage({ labels: [] });
    const bystander = await insertMessage({ labels: ['Untouched'] });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['Work']));

    await loaded.service.classifyAndLabel(USER_ID, target);

    expect(await storedLabels(target)).toEqual(['Work']);
    expect(await storedLabels(bystander)).toEqual(['Untouched']);
  });

  it('refuses to label a message belonging to another account', async () => {
    // The lookup is scoped by `(id, user_id)`, so from the stranger's side the
    // message simply does not exist — no upstream call, no write.
    const messageId = await insertMessage({ labels: ['Private'] });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['Work']));

    await loaded.service.classifyAndLabel(STRANGER_ID, messageId);

    expect(loaded.axiosPost).not.toHaveBeenCalled();
    expect(await storedLabels(messageId)).toEqual(['Private']);
  });
});

describe('what the classifier is given', () => {
  it('sends the message body — the PROTECTED `text` column really is fetched', async () => {
    // `text` is `select: false`'s replacement and is named explicitly in the
    // projection. Drop it and the prompt still goes out, the model still
    // answers, and nothing fails — it just classifies an empty body.
    const messageId = await insertMessage({
      subject: 'Flight confirmation',
      text: 'Your booking reference is ABC123.',
    });
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply([]));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    const prompt = promptOf(loaded.axiosPost);
    expect(prompt).toContain('Your booking reference is ABC123.');
    expect(prompt).toContain('Flight confirmation');
    expect(prompt).toContain('Sender <sender@example.com>');
  });

  it('truncates the body at the configured limit', async () => {
    const body = 'x'.repeat(50);
    const messageId = await insertMessage({ text: body });
    loaded = await loadService({ maxBodyChars: 10 });
    loaded.axiosPost.mockResolvedValue(aiReply([]));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    expect(promptOf(loaded.axiosPost)).toContain(`Body: ${'x'.repeat(10)}\n`);
  });

  it('offers the SYSTEM labels even when the account owns no label rows', async () => {
    // The system labels have no rows behind them, so an account that never made
    // a label would otherwise have nothing to classify into.
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply([]));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    const prompt = promptOf(loaded.axiosPost);
    for (const label of SYSTEM_LABELS) {
      expect(prompt).toContain(JSON.stringify(label.name));
    }
  });

  it("offers the account's own labels, and only its own", async () => {
    await getDb()
      .insert(labelsTable)
      .values([
        { userId: USER_ID, name: 'Invoices' },
        { userId: STRANGER_ID, name: 'SomeoneElsesLabel' },
      ]);
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply([]));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    const prompt = promptOf(loaded.axiosPost);
    expect(prompt).toContain('"Invoices"');
    expect(prompt).not.toContain('SomeoneElsesLabel');
  });

  it('does not offer a system label twice when a row shadows its name', async () => {
    const shadowed = SYSTEM_LABELS[0].name;
    await getDb().insert(labelsTable).values({ userId: USER_ID, name: shadowed });
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply([]));

    await loaded.service.classifyAndLabel(USER_ID, messageId);

    const offered = JSON.parse(
      /Available labels: (\[.*?\])\n/s.exec(promptOf(loaded.axiosPost))?.[1] ?? '[]'
    ) as string[];
    expect(offered.filter((name) => name === shadowed)).toHaveLength(1);
  });
});

describe('the bounded background queue', () => {
  it('bounds concurrency and queue size', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => insertMessage()));
    loaded = await loadService({ maxConcurrent: 2, maxQueueSize: 4 });

    const axiosResolvers: Array<(value: unknown) => void> = [];
    loaded.axiosPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          axiosResolvers.push(resolve);
        })
    );

    expect(loaded.service.enqueueClassification(USER_ID, ids[0])).toBe(true);
    expect(loaded.service.enqueueClassification(USER_ID, ids[1])).toBe(true);
    expect(loaded.service.enqueueClassification(USER_ID, ids[2])).toBe(true);
    expect(loaded.service.enqueueClassification(USER_ID, ids[3])).toBe(true);
    expect(loaded.service.enqueueClassification(USER_ID, ids[4])).toBe(false);

    // Only maxConcurrent (2) jobs may reach the upstream call at once; the
    // remaining queued jobs wait until an active job settles. The quiet period
    // is what makes this an upper bound rather than a snapshot taken before the
    // third job happened to start.
    await waitFor(() => loaded?.axiosPost.mock.calls.length === 2, 'two in-flight jobs');
    await quiet();
    expect(loaded.axiosPost).toHaveBeenCalledTimes(2);

    // Settling the first in-flight job frees a slot for the next queued job.
    axiosResolvers[0]?.(aiReply(['Work']));
    await waitFor(() => loaded?.axiosPost.mock.calls.length === 3, 'the third job starting');
    await quiet();
    expect(loaded.axiosPost).toHaveBeenCalledTimes(3);

    // Drain the rest so no promise is left pending across the pool close.
    for (const resolve of axiosResolvers) {
      resolve(aiReply([]));
    }
    await waitFor(() => loaded?.axiosPost.mock.calls.length === 4, 'the queue draining');
    await quiet();
  });

  it('drives an enqueued job all the way to a stored label', async () => {
    // The queue is the real entry point (`email.service.ts` enqueues, it does
    // not call `classifyAndLabel` directly), so at least one case has to prove
    // the whole path writes.
    const messageId = await insertMessage();
    loaded = await loadService();
    loaded.axiosPost.mockResolvedValue(aiReply(['Work']));

    expect(loaded.service.enqueueClassification(USER_ID, messageId)).toBe(true);
    await waitFor(
      async () => (await storedLabels(messageId)).length > 0,
      'the enqueued job to store a label'
    );

    expect(await storedLabels(messageId)).toEqual(['Work']);
  });
});
