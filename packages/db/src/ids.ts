/**
 * The two shapes an entity id can have in a schema built on {@link generatedId}
 * (`columns.ts`).
 *
 * A primary key is `text` holding a 24-char ObjectId hex for every row that
 * existed before a Mongo-to-Postgres cutover, and a uuid v7 for every row
 * created after it. Both can be live simultaneously and permanently — a
 * backfill copies the original id verbatim, so a row migrated from Mongo keeps
 * its ObjectId forever.
 *
 * ## This is for a 400, and nothing else
 *
 * A guard built on this predicate exists only to dodge a malformed-input
 * failure at a documented API boundary — never as a precondition on a query.
 * Using it to gate a lookup re-introduces a fail-open bug in a new costume: it
 * answers "no" for a perfectly valid id of a shape this predicate has not been
 * taught about yet, when the query itself already answers "no such row" for
 * free.
 *
 * A `uuid` column type is deliberately not used anywhere in a schema built on
 * these helpers, so this predicate is the ONLY place either shape is spelled
 * out.
 */

/** A 24-character MongoDB ObjectId, hex, case-insensitive. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/**
 * RFC 9562 UUID version 7, as {@link uuidv7} in `columns.ts` emits it.
 *
 * The version nibble (`7`) and variant bits (`8`/`9`/`a`/`b`) are pinned rather
 * than accepting any UUID: nothing built on these helpers generates a v4, so a
 * v4 arriving on a route is a client error worth rejecting, not an id to look
 * up.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether `value` could name a row — i.e. it is one of the two id shapes a
 * schema built on these helpers actually stores.
 *
 * `true` is NOT "this row exists"; it is only "this is not obviously
 * malformed". The existence question is the query's to answer.
 */
export function isLiveEntityId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return OBJECT_ID_HEX.test(value) || UUID_V7.test(value);
}
