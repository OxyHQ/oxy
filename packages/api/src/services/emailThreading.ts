/**
 * Stored conversations: the one writer of `messages.thread_id`.
 *
 * ## What a thread is
 *
 * Every message has a set of thread KEYS — its own `Message-ID`, the relay's
 * replacement for it, its `In-Reply-To` and every entry of `References`
 * ({@link threadKeys}). Two of one user's messages are ADJACENT when their key
 * sets intersect ({@link threadAdjacency}), and a thread is a connected
 * component of that relation. This is the definition the `WITH RECURSIVE`
 * walks in `email.service.ts` follow; they import it from here, so the stored
 * grouping and the walk cannot be built from two different relations.
 *
 * ## The invariant
 *
 * Every row of one component carries the same `thread_id`, and no row outside
 * it does. NULL means "not assigned yet" (a row stored before the column
 * existed). The value is internal: the wire `threadId` is still the smallest
 * member row id, computed by the reads.
 *
 * What can break the invariant, and what restores it:
 *
 * - **An insert** can only JOIN components — a new node with edges. Its
 *   neighbours' threads already are whole components, so one hop through the
 *   indexed adjacency is enough ({@link assignThread}): none → a new id; one →
 *   join it; several → MERGE them into the largest. A neighbour still NULL
 *   means the stored grouping cannot be trusted there, and the caller re-derives
 *   the whole component instead.
 * - **A delete, or a change to a row's keys,** can SPLIT a component (the row
 *   was a bridge) as well as join one. {@link rethread} re-derives every
 *   component reachable from the rows it is given, plus every row that carries
 *   a thread id it meets — so a split piece that is no longer reachable is still
 *   found by its stale id — and restamps whatever disagrees.
 *
 * ## Concurrency
 *
 * Two inserts that each see no neighbour would found two threads for one
 * conversation. Every writer therefore holds {@link withThreadLock} — a
 * per-user transaction-level advisory lock — from before it reads the
 * adjacency until it commits.
 *
 * Lock order: a transaction takes the thread lock BEFORE it locks any
 * `messages` row of that user. The lock holder rewrites `thread_id` on other
 * rows of the same user; if a transaction could hold one of those rows while
 * waiting for the thread lock, the two would deadlock. The insert paths that
 * run inside a caller's transaction (a send filed with its outbox claim) hold
 * only outbox rows by then, which no lock holder ever waits on. Rows are
 * relocked in `id` order before a multi-row rewrite, so two rewrites of
 * overlapping rows cannot deadlock either.
 *
 * Merges and splits never touch `updated_at`: a thread id moving is not an edit
 * to the message, and every rewrite here is raw SQL, which the `$onUpdate` hook
 * of `updatedAt()` does not see.
 */

import { type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { Transaction } from '../config/postgres';

/**
 * The SQL set of RFC Message-ID tokens that place one message in a thread: its
 * own `Message-ID`, the relay's replacement for it, its `In-Reply-To`, and
 * every entry of `References`.
 *
 * Two messages are in the same thread exactly when these sets intersect.
 * Stating it as one symmetric relation is what lets a walk be transitive
 * instead of one hop.
 */
export function threadKeys(alias: string): SQL {
  // `references` is a RESERVED word; drizzle quotes every identifier it emits
  // and hand-written SQL has to do the same.
  const table = sql.raw(alias);
  return sql`(${table}."references"
    || case when ${table}.in_reply_to is null then '{}'::text[] else array[${table}.in_reply_to] end
    || case when ${table}.relay_message_id is null then '{}'::text[] else array[${table}.relay_message_id] end
    || array[${table}.message_id])`;
}

/**
 * The adjacency predicate — "this row's key set meets `keys`" — decomposed so
 * each arm can use an index: `messages_user_id_message_id_idx`,
 * `messages_user_id_relay_message_id_idx`, `messages_user_id_in_reply_to_idx`
 * and the GIN `messages_references_idx` respectively. Written as one array
 * overlap it would be a sequential scan of every message the user owns.
 */
export function threadAdjacency(alias: string, keys: SQL): SQL {
  const table = sql.raw(alias);
  return sql`(${table}.message_id = any(${keys})
    or ${table}.relay_message_id = any(${keys})
    or ${table}.in_reply_to = any(${keys})
    or ${table}.references && ${keys})`;
}

/** The fields of a message its thread keys are made of. */
export interface ThreadKeyFields {
  messageId: string;
  inReplyTo?: string | null;
  relayMessageId?: string | null;
  references?: readonly string[] | null;
}

/**
 * The same key set as {@link threadKeys}, for a row that is not stored yet.
 * Any string is a key, the empty one included, exactly as in SQL; only a
 * missing value is not.
 */
export function threadKeysOf(fields: ThreadKeyFields): string[] {
  const keys = new Set<string>(fields.references ?? []);
  if (fields.inReplyTo !== null && fields.inReplyTo !== undefined) keys.add(fields.inReplyTo);
  if (fields.relayMessageId !== null && fields.relayMessageId !== undefined) {
    keys.add(fields.relayMessageId);
  }
  keys.add(fields.messageId);
  return [...keys];
}

/** Whether two key sets differ, i.e. whether a change can move the row between threads. */
export function threadKeysDiffer(before: ThreadKeyFields, after: ThreadKeyFields): boolean {
  const a = new Set(threadKeysOf(before));
  const b = threadKeysOf(after);
  return a.size !== b.length || b.some((key) => !a.has(key));
}

/**
 * Serialize every write to one user's thread state, until the transaction
 * ends. Take it before locking any of that user's `messages` rows (see the
 * module comment for why). Re-entrant within one transaction.
 */
export async function withThreadLock(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`oxy:email-threads:${userId}`}, 0))`,
  );
}

const textArray = (values: readonly string[]): SQL => sql`${sql.param([...values])}::text[]`;

/** The deterministic order thread ids are compared in: code units, not a collation. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The thread a message about to be inserted with these keys belongs to, merging
 * the threads it bridges. Call with {@link withThreadLock} held, then insert
 * the row with the id returned.
 *
 * Returns `null` when a neighbour is not assigned yet: the stored grouping is
 * incomplete around it, so the caller inserts the row with a NULL thread and
 * then calls {@link rethread} on it, which assigns the whole component.
 */
export async function assignThread(
  tx: Transaction,
  userId: string,
  keys: readonly string[],
): Promise<string | null> {
  const neighbours = await tx.execute<{ threadId: string | null }>(sql`
    select distinct m.thread_id as "threadId"
    from messages m
    where m.user_id = ${userId} and ${threadAdjacency('m', textArray(keys))}
  `);
  if (neighbours.length === 0) return uuidv7();
  const threadIds: string[] = [];
  for (const row of neighbours) {
    if (row.threadId === null) return null;
    threadIds.push(row.threadId);
  }
  if (threadIds.length === 1) return threadIds[0];

  // A bridge: the threads it joins become one, kept under the id of the
  // largest so the fewest rows are rewritten.
  const sizes = await tx.execute<{ threadId: string; size: number }>(sql`
    select m.thread_id as "threadId", count(*)::int as size
    from messages m
    where m.user_id = ${userId} and m.thread_id = any(${textArray(threadIds)})
    group by m.thread_id
  `);
  const [winner, ...losers] = sizes
    .slice()
    .sort((a, b) => b.size - a.size || byCodeUnit(a.threadId, b.threadId))
    .map((row) => row.threadId);
  await tx.execute(sql`
    update messages m set thread_id = ${winner}
    where m.id in (
      select l.id from messages l
      where l.user_id = ${userId} and l.thread_id = any(${textArray(losers)})
      order by l.id
      for no key update
    )
  `);
  return winner;
}

/** One stored row as the component computation sees it. */
export type ThreadRow = {
  id: string;
  threadId: string | null;
  keys: Array<string | null>;
};

/**
 * Every row of every component that contains one of `seedIds`.
 *
 * Walks KEYS rather than rows: each key is expanded once, so a conversation
 * where every message names the same root costs one lookup per member, not one
 * per pair of members. (The row walk the reads use re-expands the whole thread
 * from every member it reaches; on a 5000-message thread that is 25 million
 * index probes.) The component is the same either way: a row is reached
 * exactly when it carries a reached key.
 */
async function componentRows(
  tx: Transaction,
  userId: string,
  seedIds: readonly string[],
): Promise<ThreadRow[]> {
  return tx.execute<ThreadRow>(sql`
    with recursive reached(key) as (
        select unnest(${threadKeys('seed')})
        from messages seed
        where seed.user_id = ${userId} and seed.id = any(${textArray(seedIds)})
      union
        select unnest(${threadKeys('linked')})
        from reached
        join messages linked
          on linked.user_id = ${userId}
         and ${threadAdjacency('linked', sql`array[reached.key]`)}
    )
    select member.id, member.thread_id as "threadId", ${threadKeys('member')} as keys
    from messages member
    where member.user_id = ${userId}
      and ${threadAdjacency('member', sql`(select array_agg(key) from reached)::text[]`)}
  `);
}

/**
 * Partition rows into connected components by shared keys (union-find) — the
 * same relation as {@link threadAdjacency}, computed in memory.
 */
export function threadComponents(rows: readonly ThreadRow[]): ThreadRow[][] {
  const parent = rows.map((_, index) => index);
  const find = (start: number): number => {
    let index = start;
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const holder = new Map<string, number>();
  rows.forEach((row, index) => {
    for (const key of row.keys) {
      if (key === null) continue;
      const other = holder.get(key);
      if (other === undefined) holder.set(key, index);
      else parent[find(index)] = find(other);
    }
  });
  const groups = new Map<number, ThreadRow[]>();
  rows.forEach((row, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(row);
    else groups.set(root, [row]);
  });
  return [...groups.values()];
}

/**
 * The thread id each component keeps: the existing id most of its rows carry
 * (tie → the smaller id), each existing id kept by at most one component, and
 * a fresh one for the rest. When a thread splits, its larger piece keeps the id.
 */
function chooseThreadIds(groups: readonly ThreadRow[][]): string[] {
  const candidates: Array<{ group: number; threadId: string; size: number }> = [];
  groups.forEach((group, index) => {
    const sizes = new Map<string, number>();
    for (const row of group) {
      if (row.threadId !== null) sizes.set(row.threadId, (sizes.get(row.threadId) ?? 0) + 1);
    }
    for (const [threadId, size] of sizes) candidates.push({ group: index, threadId, size });
  });
  candidates.sort(
    (a, b) => b.size - a.size || byCodeUnit(a.threadId, b.threadId) || a.group - b.group,
  );
  const chosen = new Map<number, string>();
  const taken = new Set<string>();
  for (const candidate of candidates) {
    if (chosen.has(candidate.group) || taken.has(candidate.threadId)) continue;
    chosen.set(candidate.group, candidate.threadId);
    taken.add(candidate.threadId);
  }
  return groups.map((_, index) => chosen.get(index) ?? uuidv7());
}

/** What one {@link rethread} found and changed. */
export interface RethreadResult {
  /** Rows in the components it re-derived. */
  rows: number;
  /** Components among them. */
  threads: number;
  /** Rows whose `thread_id` was (or, with `dryRun`, would be) rewritten. */
  restamped: number;
}

/**
 * Re-derive the components containing `seedIds`, and restamp every row whose
 * `thread_id` disagrees. Call with {@link withThreadLock} held.
 *
 * The set grows to a fixed point: every row carrying a thread id met along the
 * way is included too, so the rows a split cut off — no longer reachable from
 * the seeds, still carrying the old id — get an id of their own.
 *
 * `dryRun` computes the same answer and writes nothing.
 */
export async function rethread(
  tx: Transaction,
  userId: string,
  seedIds: readonly string[],
  options: { dryRun?: boolean } = {},
): Promise<RethreadResult> {
  const known = new Map<string, ThreadRow>();
  const seenThreads = new Set<string>();
  let pending = [...new Set(seedIds)];
  while (pending.length > 0) {
    for (const row of await componentRows(tx, userId, pending)) known.set(row.id, row);
    const newThreads = [...known.values()]
      .map((row) => row.threadId)
      .filter((threadId): threadId is string => threadId !== null && !seenThreads.has(threadId));
    for (const threadId of newThreads) seenThreads.add(threadId);
    if (newThreads.length === 0) break;
    const carriers = await tx.execute<{ id: string }>(sql`
      select m.id from messages m
      where m.user_id = ${userId} and m.thread_id = any(${textArray([...new Set(newThreads)])})
    `);
    pending = carriers.map((row) => row.id).filter((id) => !known.has(id));
  }

  const groups = threadComponents([...known.values()]);
  const threadIds = chooseThreadIds(groups);
  const ids: string[] = [];
  const targets: string[] = [];
  groups.forEach((group, index) => {
    for (const row of group) {
      if (row.threadId === threadIds[index]) continue;
      ids.push(row.id);
      targets.push(threadIds[index]);
    }
  });

  if (ids.length > 0 && !options.dryRun) {
    await tx.execute(sql`
      select m.id from messages m
      where m.user_id = ${userId} and m.id = any(${textArray(ids)})
      order by m.id
      for no key update
    `);
    await tx.execute(sql`
      update messages m set thread_id = v.thread_id
      from unnest(${textArray(ids)}, ${textArray(targets)}) as v(id, thread_id)
      where m.user_id = ${userId} and m.id = v.id
    `);
  }
  return { rows: known.size, threads: groups.length, restamped: ids.length };
}

/** A row that was just deleted, as `DELETE … RETURNING` hands it back. */
export interface RemovedThreadMember extends ThreadKeyFields {
  threadId: string | null;
}

/**
 * Restore the invariant after rows were deleted: whatever is left of their
 * threads may have fallen apart (a deleted row was the bridge). Call with
 * {@link withThreadLock} held, in the transaction that deleted them.
 *
 * A removed row that was never assigned has no thread to re-split, so its
 * former neighbours are re-derived instead — that also assigns them.
 */
export async function rethreadAfterDelete(
  tx: Transaction,
  userId: string,
  removed: readonly RemovedThreadMember[],
): Promise<void> {
  const threadIds = [
    ...new Set(removed.map((row) => row.threadId).filter((id): id is string => id !== null)),
  ];
  const unassignedKeys = [
    ...new Set(removed.filter((row) => row.threadId === null).flatMap(threadKeysOf)),
  ];
  const seeds = new Set<string>();
  if (threadIds.length > 0) {
    const rows = await tx.execute<{ id: string }>(sql`
      select m.id from messages m
      where m.user_id = ${userId} and m.thread_id = any(${textArray(threadIds)})
    `);
    for (const row of rows) seeds.add(row.id);
  }
  if (unassignedKeys.length > 0) {
    const rows = await tx.execute<{ id: string }>(sql`
      select m.id from messages m
      where m.user_id = ${userId} and ${threadAdjacency('m', textArray(unassignedKeys))}
    `);
    for (const row of rows) seeds.add(row.id);
  }
  if (seeds.size > 0) await rethread(tx, userId, [...seeds]);
}
