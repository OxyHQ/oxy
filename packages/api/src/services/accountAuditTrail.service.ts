/**
 * One account's audit trail, unioned across the two audit event tables that
 * record who changed what (issue #972, workstreams 9 and 16).
 *
 * Console had no way to answer "what changed on this account, and who did it":
 * both existing audit reads are PER-ENTITY (`…/credentials/:credId/audit`,
 * `…/provider-connections/:connectionId/audit`), so an account-wide view
 * assembled client-side would be one request per credential per application plus
 * one per connection — an unbounded fan-out producing an aggregate the API never
 * computed. This is that aggregate, computed once, where the rows live.
 *
 * ## The two sources do NOT share an actor model, and flattening them loses the
 * distinction #1043 exists to make
 *
 * `inference_provider_connection_audit_events` carries an explicit `actor_kind`
 * (`user` / `service` / `platform`, with a CHECK tying it to the presence of an
 * actor id) — so a person and a service token are distinguishable there.
 * `application_credential_audit_events` carries no actor kind at all, only
 * `actor_user_id`, whose NULL means something entirely different: nobody
 * performed the event, because it is a `validation_failed` row recording a
 * request that was refused.
 *
 * Merged into one nullable actor id, a refused credential validation would be
 * indistinguishable from a connection event caused by a service token. So the
 * union projects a DISCRIMINATED actor, and the credential side's arm is derived
 * from `event_type` rather than from the nullness of the id. There is
 * deliberately no `service` arm on the credential side: that source cannot
 * produce one, and inventing it would let a reader believe a machine had rotated
 * a key.
 *
 * `actor_kind` is nullable on connection rows written before #1043. Those resolve
 * to `unknown` rather than being guessed into `user`, because a row that never
 * recorded its actor kind is not evidence about who acted.
 *
 * ## Why one SQL statement rather than two queries merged in TypeScript
 *
 * Ordering across two sources is the one thing that must not be got wrong, and
 * two queries merged in application code means TWO definitions of the order — the
 * `order by` in each statement and a comparator in TypeScript — which must agree
 * forever. A single `union all` leaves exactly one definition, in SQL, so there is
 * nothing to disagree with.
 *
 * The cost is a raw `db.execute`, which bypasses drizzle's result mapper, and the
 * mapper does more than the bigint conversion it is usually remembered for.
 * MEASURED against this database, a raw execute returns:
 *
 *   - `timestamptz` as a STRING in Postgres wire format
 *     (`2026-08-17 22:05:40.003125+00`) — not a `Date`, and not ISO-8601.
 *   - no `mode: 'number'` bigint handling, which is why this projection contains
 *     no bigint column and must not gain one without revisiting this.
 *
 * The timestamp is the trap that matters, because the obvious handling of it is
 * wrong in a way nothing would report: `new Date(value).toISOString()` truncates
 * the microseconds, so a cursor built from the converted value silently excludes
 * every row between the truncated millisecond and the true value. The cursor
 * therefore carries the raw string verbatim — see {@link AuditCursor}.
 *
 * ## The ordering, and why `created_at` alone is not enough
 *
 * The sort key is the TRIPLE `(created_at desc, source desc, id desc)`, and every
 * component descends. That uniformity is REQUIRED, not stylistic: the cursor is a
 * row-value comparison `(created_at, source, id) < (…)`, and a row-value
 * comparison expresses a keyset only when the whole key sorts one way. This was
 * written first as `source asc` beside a `<` keyset, and the tie test below
 * caught it — the two tied rows ordered `application_credential` then
 * `provider_connection`, while the keyset asked for rows whose source sorted
 * BELOW `application_credential`, so the second tied row was skipped. Mixed
 * directions need nested `or` conditions instead; one direction needs nothing.
 *
 * `created_at` alone is not a total order, and the credential table's own
 * documentation says why: a rotation writes the `rotated` row and the
 * replacement's `created` row in ONE transaction, so they share `now()`, and uuid
 * v7 is not monotone within a millisecond. Across two tables it is worse —
 * nothing correlates their ids, so ties are arbitrary between sources as well as
 * within one.
 *
 * A cursor over a non-total order SKIPS ROWS SILENTLY: paging past a tie drops
 * whichever tied row the second query happened to order first. So the cursor is
 * the whole triple, compared row-wise, and `__tests__/accountAuditTrail.test.ts`
 * pages across two rows that share an instant ACROSS the two sources — without
 * that case a test cannot tell a correct cursor from a lucky one.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';

/** Which table a trail entry came from. Also the ordering's tiebreak. */
export const ACCOUNT_AUDIT_SOURCES = ['application_credential', 'provider_connection'] as const;

export type AccountAuditSource = (typeof ACCOUNT_AUDIT_SOURCES)[number];

/**
 * Who caused an event.
 *
 * A discriminated union rather than a nullable id, so the four cases cannot be
 * collapsed into "there is no actor":
 *
 *  - `user` — a named person, with their id.
 *  - `service` — a service credential. Only a connection event can be this.
 *  - `platform` — Oxy itself, e.g. an automated validation.
 *  - `none` — nobody acted. A refused credential validation: a request arrived
 *    and was turned away, so there is no actor to name.
 *  - `unknown` — the row predates `actor_kind` and never recorded one.
 */
export type AccountAuditActor =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service' }
  | { readonly kind: 'platform' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' };

/** One entry of an account's trail. */
export interface AccountAuditEntry {
  readonly source: AccountAuditSource;
  /** Each source's own closed event vocabulary; never merged into one enum. */
  readonly eventType: string;
  readonly actor: AccountAuditActor;
  /** The credential or connection the event is about. */
  readonly subjectId: string;
  /** The owning application, for a credential event. Null for a connection. */
  readonly applicationId: string | null;
  /** Why a credential validation was refused. Null everywhere else. */
  readonly reason: string | null;
  readonly environment: string | null;
  readonly createdAt: string;
}

export interface AccountAuditPage {
  readonly entries: readonly AccountAuditEntry[];
  /** Hand back verbatim for the next page. Null when the trail is exhausted. */
  readonly nextCursor: string | null;
}

/**
 * The keyset a cursor encodes: the whole sort key, not just the timestamp.
 *
 * `createdAt` is the timestamp string EXACTLY as Postgres returned it —
 * `2026-08-17 22:05:40.003125+00`, microsecond precision — and it is never
 * round-tripped through a `Date`. MEASURED: a raw `db.execute` returns
 * `timestamptz` as that string, and `new Date(...).toISOString()` truncates it to
 * milliseconds. A cursor carrying the truncated value would exclude every row
 * between the truncated millisecond and the true microsecond value, which is the
 * silent row-skip this whole keyset exists to prevent — reintroduced by the
 * conversion rather than by the ordering.
 */
interface AuditCursor {
  readonly createdAt: string;
  readonly source: AccountAuditSource;
  readonly id: string;
}

export const ACCOUNT_AUDIT_MAX_LIMIT = 200;
export const ACCOUNT_AUDIT_DEFAULT_LIMIT = 50;

/**
 * Encode a keyset position opaquely, following `appChainRead.service.ts`.
 *
 * Opaque so the pagination axis stays an implementation detail and a caller
 * cannot pin `created_at` to an arbitrary point to probe when a specific event
 * was written.
 */
export function encodeAccountAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(
    `${cursor.createdAt}|${cursor.source}|${cursor.id}`,
    'utf8'
  ).toString('base64url');
}

/**
 * Decode a cursor, or `null` when it is not one we issued.
 *
 * `null` rather than a throw, matching the chain reader: the caller then reads
 * from the start, which is what passing nothing does. An error would confirm the
 * format is guessable.
 */
export function decodeAccountAuditCursor(raw: string): AuditCursor | null {
  // No try/catch, deliberately: MEASURED, neither `Buffer.from(_, 'base64url')`
  // nor `new Date(_)` throws on garbage — the first yields a short or empty
  // buffer and the second an Invalid Date. A catch here would look like it
  // handled malformed input while the checks below are what actually do.
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (parts.length !== 3) return null;
  const [rawCreatedAt, rawSource, id] = parts;
  // Validated as a timestamp but KEPT as the original string: parsing proves it
  // is one, converting would cost the microseconds.
  if (Number.isNaN(new Date(rawCreatedAt).getTime()) || id === '') return null;
  if (!ACCOUNT_AUDIT_SOURCES.includes(rawSource as AccountAuditSource)) return null;
  return { createdAt: rawCreatedAt, source: rawSource as AccountAuditSource, id };
}

/**
 * The row shape the union projects. Text and timestamps only — see the header.
 *
 * A `type` rather than an `interface` because `db.execute<T>` constrains `T` to
 * `Record<string, unknown>`, which an interface does not satisfy — only a type
 * alias gets the implicit index signature.
 */
type AuditRow = {
  readonly source: string;
  readonly id: string;
  readonly eventType: string;
  readonly actorUserId: string | null;
  readonly actorKind: string | null;
  readonly subjectId: string;
  readonly applicationId: string | null;
  readonly reason: string | null;
  readonly environment: string | null;
  readonly createdAt: string;
};

/**
 * The actor, resolved per source.
 *
 * The credential branch reads `event_type`, never the nullness of
 * `actor_user_id` — see the header. `validation_failed` is the only credential
 * event with no actor, and it has none because a refused request has no actor,
 * not because the column happened to be null.
 */
function actorOf(row: AuditRow): AccountAuditActor {
  if (row.source === 'application_credential') {
    if (row.eventType === 'validation_failed') return { kind: 'none' };
    return row.actorUserId === null
      ? { kind: 'unknown' }
      : { kind: 'user', userId: row.actorUserId };
  }

  switch (row.actorKind) {
    case 'user':
      // The table's CHECK guarantees an id here; the guard is for a row written
      // before that constraint rather than a doubt about the constraint.
      return row.actorUserId === null
        ? { kind: 'unknown' }
        : { kind: 'user', userId: row.actorUserId };
    case 'service':
      return { kind: 'service' };
    case 'platform':
      return { kind: 'platform' };
    default:
      // Pre-#1043 rows recorded no kind. Not guessed into `user`.
      return { kind: 'unknown' };
  }
}

/**
 * One page of an account's audit trail, newest first.
 *
 * Authorises nothing: the caller has already established that this account is
 * one it may read. Credential events are scoped through
 * `applications.owner_account_id`, which is where a credential's account lives;
 * connection events carry `owner_account_id` on the row itself.
 */
export async function listAccountAuditTrail(
  accountId: string,
  options: { readonly limit: number; readonly cursor?: string | null } = {
    limit: ACCOUNT_AUDIT_DEFAULT_LIMIT,
  }
): Promise<AccountAuditPage> {
  const limit = Math.min(Math.max(options.limit, 1), ACCOUNT_AUDIT_MAX_LIMIT);
  const cursor =
    options.cursor === undefined || options.cursor === null
      ? null
      : decodeAccountAuditCursor(options.cursor);

  // Row-wise comparison against the WHOLE sort key. `created_at < x` alone would
  // skip every row tied with the cursor's own instant.
  const keyset =
    cursor === null
      ? sql`true`
      : sql`(t."createdAt", t.source, t.id) < (${cursor.createdAt}::timestamptz, ${cursor.source}, ${cursor.id})`;

  // One more than asked for, so "is there another page" is answered by reading a
  // row rather than by a second count query that could disagree with it.
  const rows = await getDb().execute<AuditRow>(sql`
    with trail as (
      select
        'application_credential' as source,
        e.id                     as id,
        e.event_type             as "eventType",
        e.actor_user_id          as "actorUserId",
        null::text               as "actorKind",
        e.credential_id          as "subjectId",
        e.application_id         as "applicationId",
        e.reason                 as reason,
        e.environment            as environment,
        e.created_at             as "createdAt"
      from application_credential_audit_events e
      join applications a on a.id = e.application_id
      where a.owner_account_id = ${accountId}

      union all

      select
        'provider_connection' as source,
        c.id                  as id,
        c.event_type          as "eventType",
        c.actor_user_id       as "actorUserId",
        c.actor_kind          as "actorKind",
        c.connection_id       as "subjectId",
        null::text            as "applicationId",
        null::text            as reason,
        c.environment         as environment,
        c.created_at          as "createdAt"
      from inference_provider_connection_audit_events c
      where c.owner_account_id = ${accountId}
    )
    select t.* from trail t
    where ${keyset}
    order by t."createdAt" desc, t.source desc, t.id desc
    limit ${limit + 1}
  `);

  return pageOf(rows, limit);
}

/** Shape a fetched window into a page, dropping the lookahead row. */
function pageOf(rows: readonly AuditRow[], limit: number): AccountAuditPage {
  const window = rows.slice(0, limit);
  const entries = window.map((row) => ({
    source: row.source as AccountAuditSource,
    eventType: row.eventType,
    actor: actorOf(row),
    subjectId: row.subjectId,
    applicationId: row.applicationId,
    reason: row.reason,
    environment: row.environment,
    // ISO for the wire, so the published shape is stable; the CURSOR keeps the
    // raw microsecond string instead.
    createdAt: new Date(row.createdAt).toISOString(),
  }));

  const last = window[window.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeAccountAuditCursor({
          createdAt: last.createdAt,
          source: last.source as AccountAuditSource,
          id: last.id,
        })
      : null;

  return { entries, nextCursor };
}
