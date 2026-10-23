/**
 * Stored thread ids (`messages.thread_id`), against a REAL Postgres, through
 * the real write paths.
 *
 * The invariant `services/emailThreading.ts` keeps: the rows sharing a
 * `thread_id` are exactly one connected component of the Message-ID adjacency
 * a `WITH RECURSIVE` walk follows. The oracle here is that walk — the one the
 * reads ran before the key was stored — and the comparison is made after EVERY
 * write:
 *
 * - a randomized run (seeded, so a failure replays) over every path that
 *   creates, deletes or re-keys a message: inbound in any order (a reply before
 *   its parent), sends, self-sends coming back, drafts and their edits, a draft
 *   removed once sent, a relay id recorded after a reply already named it, and
 *   permanent deletes — any of which can be the bridge between two threads;
 * - the cases a random run could miss by chance, pinned one by one: a merge, a
 *   split, a child before its parent, and the per-user lock under a forced
 *   interleaving.
 */

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
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import { threadAdjacency, threadKeys, withThreadLock } from '../emailThreading';

const unique = () => randomUUID().replace(/-/g, '');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** A user every write path accepts: a username, and the system mailboxes. */
async function mailUser(): Promise<{ id: string; username: string; address: string }> {
  const username = `thr${unique().slice(0, 10)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  await emailService.ensureMailboxes(row.id);
  return { id: row.id, username, address: `${username}@oxy.so` };
}

/** Every row the user owns, with its stored thread. */
async function storedThreads(userId: string) {
  return getDb()
    .select({ id: messages.id, threadId: messages.threadId, updatedAt: messages.updatedAt })
    .from(messages)
    .where(eq(messages.userId, userId));
}

/** `id → thread_id`, for the rows asked about. */
async function threadOf(userId: string): Promise<Map<string, string | null>> {
  return new Map((await storedThreads(userId)).map((row) => [row.id, row.threadId]));
}

/**
 * The partition the WALK defines — the same `WITH RECURSIVE` row walk
 * `getThread` runs, from every row not yet placed — as sorted member lists.
 * This is the oracle: the stored grouping must equal it.
 */
async function walkPartition(userId: string): Promise<string[][]> {
  const ids = (await storedThreads(userId)).map((row) => row.id);
  const placed = new Set<string>();
  const groups: string[][] = [];
  for (const id of ids) {
    if (placed.has(id)) continue;
    const members = await getDb().execute<{ id: string }>(sql`
      with recursive walk(id, ks) as (
          select seed.id, ${threadKeys('seed')}
          from messages seed
          where seed.user_id = ${userId} and seed.id = ${id}
        union
          select linked.id, ${threadKeys('linked')}
          from walk
          join messages linked
            on linked.user_id = ${userId}
           and ${threadAdjacency('linked', sql.raw('walk.ks'))}
      )
      select id from walk
    `);
    const group = [...new Set(members.map((row) => row.id))].sort();
    for (const member of group) placed.add(member);
    groups.push(group);
  }
  return groups.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The partition the STORED thread ids define, in the same shape. */
async function storedPartition(userId: string): Promise<string[][]> {
  const byThread = new Map<string, string[]>();
  for (const row of await storedThreads(userId)) {
    // A NULL would be a row no path assigned: fail with its id in the message.
    expect({ id: row.id, threadId: row.threadId }).toEqual({
      id: row.id,
      threadId: expect.any(String),
    });
    const group = byThread.get(row.threadId ?? '') ?? [];
    group.push(row.id);
    byThread.set(row.threadId ?? '', group);
  }
  return [...byThread.values()].map((group) => group.sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Deterministic PRNG (mulberry32), so a failing seed replays exactly. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits observed across every seed; most single deletes do not disconnect anything. */
const randomRuns = { splits: 0 };

describe('stored thread ids — the grouping equals the walk after every write', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'random arrival order, bridges, self-sends, drafts, relay ids and deletes (seed %i)',
    async (seed) => {
      const random = prng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
      const user = await mailUser();
      const sent = await emailService.getMailboxBySpecialUse(user.id, '\\Sent');
      if (!sent) throw new Error('no Sent mailbox');

      // Keys handed out before (or without) the message that carries them, so
      // a reply can arrive before its parent and a relay id can be named before
      // it is recorded.
      const keys = Array.from({ length: 14 }, (_, n) => `<k${n}-${unique()}@example.com>`);
      const unused = [...keys];
      const takeKey = () => unused.splice(Math.floor(random() * unused.length), 1)[0];
      const headers = () => ({
        ...(random() < 0.6 ? { inReplyTo: pick(keys) } : {}),
        references: Array.from({ length: Math.floor(random() * 4) }, () => pick(keys)),
      });
      const sentRows: Array<{ id: string; messageId: string }> = [];
      const drafts: string[] = [];
      const steps: string[] = [];
      let largestThread = 0;
      let splits = 0;
      let previous: string[][] = [];

      for (let step = 0; step < 48; step++) {
        const roll = random();
        if (roll < 0.35 || unused.length === 0) {
          const messageId =
            unused.length > 0 && random() < 0.7 ? takeKey() : `<x-${unique()}@example.com>`;
          await emailService.storeIncomingMessage({
            recipientUsername: user.username,
            from: { address: `peer${Math.floor(random() * 4)}@example.com` },
            to: [{ address: user.address }],
            subject: 'random',
            text: 'body',
            messageId,
            ...headers(),
            date: new Date(),
            headers: {},
            rawSize: 100,
          });
          steps.push(`inbound ${messageId}`);
        } else if (roll < 0.5) {
          const messageId =
            random() < 0.5 && unused.length > 0 ? takeKey() : `<s-${unique()}@oxy.so>`;
          const dto = await emailService.storeSentMessage(user.id, {
            messageId,
            from: { address: user.address },
            to: [{ address: 'peer@example.com' }],
            subject: 'sent',
            text: 'body',
            size: 10,
            ...headers(),
          });
          sentRows.push({ id: dto.id, messageId });
          steps.push(`sent ${messageId}`);
        } else if (roll < 0.57 && sentRows.length > 0) {
          // A self-send coming back: same Message-ID as a Sent row.
          const original = pick(sentRows);
          await emailService.storeIncomingMessage({
            recipientUsername: user.username,
            from: { address: user.address },
            to: [{ address: user.address }],
            subject: 'sent',
            text: 'body',
            messageId: original.messageId,
            date: new Date(),
            headers: { 'x-oxy-sent-id': original.messageId },
            rawSize: 100,
          });
          steps.push(`self-copy ${original.messageId}`);
        } else if (roll < 0.66) {
          const dto = await emailService.saveDraft(user.id, {
            subject: 'draft',
            text: 'draft body',
            ...headers(),
          });
          drafts.push(dto.id);
          steps.push(`draft ${dto.id}`);
        } else if (roll < 0.74 && drafts.length > 0) {
          const draftId = pick(drafts);
          await emailService.saveDraft(user.id, {
            existingDraftId: draftId,
            subject: 'draft',
            text: 'edited',
            ...headers(),
          });
          steps.push(`draft-edit ${draftId}`);
        } else if (roll < 0.8 && drafts.length > 0) {
          const draftId = drafts.splice(Math.floor(random() * drafts.length), 1)[0];
          await emailService.deleteSentDraft(user.id, draftId);
          steps.push(`draft-sent ${draftId}`);
        } else if (roll < 0.88 && sentRows.length > 0 && unused.length > 0) {
          // The relay's id, possibly named by a reply that arrived first.
          const target = pick(sentRows);
          const relayId = takeKey();
          await emailService.recordRelayMessageId(user.id, target.id, relayId);
          steps.push(`relay ${target.id} ${relayId}`);
        } else {
          const rows = await storedThreads(user.id);
          if (rows.length === 0) continue;
          const victim = pick(rows).id;
          await emailService.deleteMessage(user.id, victim, true);
          const index = sentRows.findIndex((row) => row.id === victim);
          if (index >= 0) sentRows.splice(index, 1);
          const draftIndex = drafts.indexOf(victim);
          if (draftIndex >= 0) drafts.splice(draftIndex, 1);
          steps.push(`delete ${victim}`);
        }

        const [stored, walked] = [await storedPartition(user.id), await walkPartition(user.id)];
        largestThread = Math.max(largestThread, ...walked.map((group) => group.length));
        const groupOf = new Map(walked.flatMap((group) => group.map((id) => [id, group[0]])));
        for (const group of previous) {
          const now = new Set(group.map((id) => groupOf.get(id)).filter((id) => id !== undefined));
          if (now.size > 1) splits += 1;
        }
        previous = walked;
        if (JSON.stringify(stored) !== JSON.stringify(walked)) {
          throw new Error(
            `seed ${seed}, step ${step}: stored grouping differs from the walk\n` +
              `steps:\n  ${steps.join('\n  ')}\nstored: ${JSON.stringify(stored)}\nwalk:   ${JSON.stringify(walked)}`,
          );
        }
      }
      // Vacuity floor: the run built threads of three or more — an equality
      // between two partitions of singletons proves nothing.
      expect(largestThread).toBeGreaterThan(2);
      randomRuns.splits += splits;
    },
    60_000,
  );

  it('split a thread somewhere across the seeds — the delete paths were exercised', () => {
    // Runs after the seeds above (jest keeps a file's order).
    expect(randomRuns.splits).toBeGreaterThan(0);
  });
});

describe('stored thread ids — the cases the random run must not miss by chance', () => {
  it('merges two threads a bridge joins, without touching updated_at', async () => {
    const user = await mailUser();
    const left = `<left-${unique()}@example.com>`;
    const right = `<right-${unique()}@example.com>`;
    const inbound = (messageId: string, extra: { inReplyTo?: string; references?: string[] }) =>
      emailService.storeIncomingMessage({
        recipientUsername: user.username,
        from: { address: 'peer@example.com' },
        to: [{ address: user.address }],
        subject: 's',
        messageId,
        ...extra,
        date: new Date(),
        headers: {},
        rawSize: 10,
      });

    const a = await inbound(left, {});
    const b = await inbound(`<l2-${unique()}@example.com>`, { inReplyTo: left });
    const c = await inbound(right, {});
    const before = await storedThreads(user.id);
    const threads = await threadOf(user.id);
    expect(threads.get(a.id)).toBe(threads.get(b.id));
    expect(threads.get(c.id)).not.toBe(threads.get(a.id));

    const bridge = await inbound(`<bridge-${unique()}@example.com>`, { references: [left, right] });
    const after = await threadOf(user.id);
    // The larger thread (a, b) keeps its id; c moves to it.
    expect(after.get(a.id)).toBe(threads.get(a.id));
    expect(new Set([a.id, b.id, c.id, bridge.id].map((id) => after.get(id))).size).toBe(1);
    const touched = new Map((await storedThreads(user.id)).map((row) => [row.id, row.updatedAt]));
    for (const row of before) expect(touched.get(row.id)).toEqual(row.updatedAt);
  });

  it('splits a thread when the only message linking its halves is deleted', async () => {
    const user = await mailUser();
    const left = `<left-${unique()}@example.com>`;
    const right = `<right-${unique()}@example.com>`;
    const inbound = (messageId: string, references: string[] = []) =>
      emailService.storeIncomingMessage({
        recipientUsername: user.username,
        from: { address: 'peer@example.com' },
        to: [{ address: user.address }],
        subject: 's',
        messageId,
        references,
        date: new Date(),
        headers: {},
        rawSize: 10,
      });
    const a1 = await inbound(left);
    const a2 = await inbound(`<a2-${unique()}@example.com>`, [left]);
    const b1 = await inbound(right);
    const bridge = await inbound(`<bridge-${unique()}@example.com>`, [left, right]);
    const joined = await threadOf(user.id);
    expect(new Set([a1, a2, b1, bridge].map((row) => joined.get(row.id))).size).toBe(1);

    await emailService.deleteMessage(user.id, bridge.id, true);
    const after = await threadOf(user.id);
    expect(after.get(a1.id)).toBe(after.get(a2.id));
    expect(after.get(b1.id)).not.toBe(after.get(a1.id));
    expect(await storedPartition(user.id)).toEqual(await walkPartition(user.id));
  });

  it('splits again when a draft that bridged two threads is sent and removed', async () => {
    const user = await mailUser();
    const left = `<left-${unique()}@example.com>`;
    const right = `<right-${unique()}@example.com>`;
    const inbound = (messageId: string) =>
      emailService.storeIncomingMessage({
        recipientUsername: user.username,
        from: { address: 'peer@example.com' },
        to: [{ address: user.address }],
        subject: 's',
        messageId,
        date: new Date(),
        headers: {},
        rawSize: 10,
      });
    const a = await inbound(left);
    const b = await inbound(right);
    const draft = await emailService.saveDraft(user.id, {
      subject: 're',
      text: 'both',
      references: [left, right],
    });
    const joined = await threadOf(user.id);
    expect(joined.get(a.id)).toBe(joined.get(b.id));

    await emailService.deleteSentDraft(user.id, draft.id);
    const after = await threadOf(user.id);
    expect(after.get(a.id)).not.toBe(after.get(b.id));
  });

  it('threads a reply that arrived before its parent', async () => {
    const user = await mailUser();
    const parentId = `<parent-${unique()}@example.com>`;
    const store = (messageId: string, inReplyTo?: string) =>
      emailService.storeIncomingMessage({
        recipientUsername: user.username,
        from: { address: 'peer@example.com' },
        to: [{ address: user.address }],
        subject: 's',
        messageId,
        ...(inReplyTo ? { inReplyTo } : {}),
        date: new Date(),
        headers: {},
        rawSize: 10,
      });
    const child = await store(`<child-${unique()}@example.com>`, parentId);
    const parent = await store(parentId);
    const threads = await threadOf(user.id);
    expect(threads.get(child.id)).toBe(threads.get(parent.id));
  });

  it('holds the per-user lock, so a concurrent writer`s thread is seen, not raced', async () => {
    // Forced interleaving, not Promise.all: the holder takes the lock, the
    // insert is started and PROVEN to be waiting on it (pg_locks, scoped to the
    // waiter's lock key), then the holder stores the parent under a thread id
    // of its own and commits. Without the lock the reply would have read no
    // neighbour and founded a second thread.
    const user = await mailUser();
    const inbox = await emailService.getMailboxBySpecialUse(user.id, '\\Inbox');
    if (!inbox) throw new Error('no Inbox');
    const parentId = `<locked-parent-${unique()}@example.com>`;
    const heldThread = `held-${unique()}`;

    let replyDone: Promise<{ id: string }> | undefined;
    await getDb().transaction(async (tx) => {
      await withThreadLock(tx, user.id);
      replyDone = emailService.storeIncomingMessage({
        recipientUsername: user.username,
        from: { address: 'peer@example.com' },
        to: [{ address: user.address }],
        subject: 's',
        messageId: `<locked-reply-${unique()}@example.com>`,
        inReplyTo: parentId,
        date: new Date(),
        headers: {},
        rawSize: 10,
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [waiting] = await getDb().execute<{ n: number }>(sql`
          select count(*)::int as n from pg_locks
          where locktype = 'advisory' and not granted
            and objid = (hashtextextended(${`oxy:email-threads:${user.id}`}, 0) & 4294967295)::oid
        `);
        if (waiting.n > 0) break;
        if (Date.now() > deadline) throw new Error('the reply never waited on the thread lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await tx.insert(messages).values({
        userId: user.id,
        mailboxId: inbox.id,
        messageId: parentId,
        fromAddress: 'peer@example.com',
        subject: '',
        size: 10,
        date: new Date(),
        threadId: heldThread,
      });
    });
    if (!replyDone) throw new Error('the reply was never started');
    const reply = await replyDone;
    expect((await threadOf(user.id)).get(reply.id)).toBe(heldThread);
  }, 20_000);
});

describe('reads by the stored key', () => {
  /** A mailbox of every thread shape a read can meet, written through the real paths. */
  async function conversations() {
    const user = await mailUser();
    const inbound = (
      messageId: string,
      from: string,
      extra: { inReplyTo?: string; references?: string[]; headers?: Record<string, string> } = {},
    ) =>
      emailService.storeIncomingMessage({
        recipientUsername: user.username,
        from: { address: from },
        to: [{ address: user.address }],
        subject: 'conversation',
        text: 'body',
        messageId,
        inReplyTo: extra.inReplyTo,
        references: extra.references,
        date: new Date(),
        headers: extra.headers ?? {},
        rawSize: 100,
      });

    // Three participants, a reply naming only its parent, one naming both.
    const root = `<root-${unique()}@example.com>`;
    const reply = `<reply-${unique()}@example.com>`;
    await inbound(root, 'ada@example.com');
    await inbound(reply, 'grace@example.com', { inReplyTo: root, references: [root] });
    await inbound(`<third-${unique()}@example.com>`, 'alan@example.com', {
      inReplyTo: reply,
      references: [root, reply],
    });
    // A send, its self-copy coming back (counted once), and an answer to it.
    const sentId = `<sent-${unique()}@oxy.so>`;
    await emailService.storeSentMessage(user.id, {
      messageId: sentId,
      from: { address: user.address },
      to: [{ address: user.address }, { address: 'peer@example.com' }],
      subject: 'conversation',
      text: 'body',
      size: 10,
    });
    await inbound(sentId, user.address, { headers: { 'x-oxy-sent-id': sentId } });
    await inbound(`<answer-${unique()}@example.com>`, 'peer@example.com', { inReplyTo: sentId });
    // A reply whose parent is not here, and a draft answering the first thread.
    await inbound(`<orphan-${unique()}@example.com>`, 'lone@example.com', {
      inReplyTo: `<gone-${unique()}@example.com>`,
    });
    await emailService.saveDraft(user.id, { subject: 're', text: 'draft', inReplyTo: reply });
    return user;
  }

  /** Every thread-bearing read the client makes, serialized as the wire would carry it. */
  async function reads(userId: string): Promise<string> {
    const folders = await emailService.listMailboxes(userId);
    const lists = [];
    for (const folder of [...folders.map((row) => row.id), null]) {
      lists.push(await emailService.listMessages(userId, folder, { limit: 50 }));
    }
    const ids = (await storedThreads(userId)).map((row) => row.id).sort();
    const threads = [];
    const singles = [];
    for (const id of ids) {
      threads.push(await emailService.getThread(userId, id));
      singles.push(await emailService.getMessage(userId, id));
    }
    return JSON.stringify({ lists, threads, singles });
  }

  it('counts each page message`s own thread, transitively, without the self-copy', async () => {
    const user = await conversations();
    const all = await reads(user.id);
    // The three-message thread plus the draft answering it, and the send with
    // its answer (the self-copy is not counted).
    expect(all).toContain('"threadCount":4');
    expect(all).toContain('"threadCount":2');
    // The orphan reply is a thread of one: no count, its own id as threadId.
    const inbox = await emailService.getMailboxBySpecialUse(user.id, '\\Inbox');
    if (!inbox) throw new Error('no Inbox');
    const page = await emailService.listMessages(user.id, inbox.id, { limit: 50 });
    const orphan = page.data.find((message) => message.messageId.startsWith('<orphan-'));
    expect(orphan?.threadCount).toBeUndefined();
    expect(orphan?.threadId).toBe(orphan?.id);
  });

  it('follows the stored key, not the walk, once a thread has one', async () => {
    // Positive control: detach one row of the four-message thread under an id
    // of its own. The walk would still count four; the stored key counts three.
    const user = await conversations();
    const inbox = await emailService.getMailboxBySpecialUse(user.id, '\\Inbox');
    if (!inbox) throw new Error('no Inbox');
    const before = await emailService.listMessages(user.id, inbox.id, { limit: 50 });
    const counted = before.data.filter((message) => message.threadCount === 4);
    expect(counted.length).toBeGreaterThan(1);

    await getDb()
      .update(messages)
      .set({ threadId: `detached-${unique()}` })
      .where(eq(messages.id, counted[0].id));
    const after = await emailService.listMessages(user.id, inbox.id, { limit: 50 });
    expect(after.data.find((message) => message.id === counted[1].id)?.threadCount).toBe(3);
    expect((await emailService.getThread(user.id, counted[1].id)).length).toBe(3);
  });
});
