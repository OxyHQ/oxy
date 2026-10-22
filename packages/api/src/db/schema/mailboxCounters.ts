/**
 * The triggers that maintain `mailboxes.total_messages`, `unseen_messages` and
 * `size_bytes` (see `mailboxes.ts` for why they are stored at all).
 *
 * Schema SUPPORT, not a table — imported directly, never re-exported from
 * `schema/index.ts`, like `accountBillingImmutability.ts`. drizzle-kit cannot
 * emit a trigger, so the DDL is hand-written and its authoritative text lives
 * HERE; `drizzle/0206_mailbox_counter_triggers.sql` carries it verbatim, and
 * `schema/__tests__/mailboxCounters.test.ts` fails if the two differ or if a
 * trigger is missing.
 *
 * ## Why a trigger, and why per statement
 *
 * The Mongo counters drifted because each of eighteen write sites had to
 * remember an `$inc`. A trigger is the one place no write path can skip — the
 * service, a script, a cascade from deleting a user or a folder, `psql`, and
 * the image that predates this code.
 *
 * Statement-level with transition tables, not `FOR EACH ROW`: a 100-message
 * bulk move then costs ONE update per touched folder instead of 200, and the
 * folder rows are locked once, in id order (`ORDER BY id FOR NO KEY UPDATE`),
 * so two bulk moves in opposite directions cannot deadlock each other. `NO
 * KEY UPDATE` because an insert's foreign-key check holds `KEY SHARE` on the
 * same folder row, and those two do not conflict.
 *
 * An UPDATE trigger with transition tables cannot name columns
 * (`UPDATE OF seen, …`), so it fires for every UPDATE. It folds the old and
 * new rows into per-folder deltas and drops the zero ones, so an update that
 * moves no counter (labels, cards, thread ids, a snooze origin cleared by a
 * cascade) locks nothing and writes nothing.
 *
 * ## Only the owner's mail counts
 *
 * The aggregate the counters replace was keyed by user first
 * (`messages where user_id = $1 group by mailbox_id`), so a row whose
 * `user_id` is not its folder's owner — no service path writes one — never
 * counted. The deltas are grouped by `(mailbox_id, user_id)` and applied only
 * where `user_id` is the folder's owner, so the counters keep that meaning.
 *
 * ## NULL stays NULL
 *
 * `col = col + delta`, so a folder not counted yet stays NULL until
 * `src/scripts/backfill-mailbox-counters.ts` counts it. The UPDATE still runs,
 * and still takes the row lock, for a NULL folder: that lock is what makes the
 * backfill exact (it locks the folder, then counts in a fresh statement; a
 * writer either committed before the lock or waits for it and then adds its
 * delta to the counted value).
 *
 * `updated_at` is not touched: it is the folder's own edit time, maintained by
 * the application, and a new message is not an edit to the folder.
 *
 * ## TRUNCATE
 *
 * `TRUNCATE messages` fires no row or DELETE trigger. Every folder is empty
 * afterwards, so the TRUNCATE trigger sets every counter to 0.
 */

/** The table the triggers are installed on. They write `mailboxes`. */
export const MAILBOX_COUNTERS_SOURCE_TABLE = 'messages';

/** The one plpgsql function every trigger runs. */
export const MAILBOX_COUNTERS_FUNCTION = 'mailbox_counters_apply';

/** The trigger names, so the test asserting their existence names one thing. */
export const MAILBOX_COUNTERS_TRIGGERS = {
  insert: 'messages_mailbox_counters_insert',
  update: 'messages_mailbox_counters_update',
  delete: 'messages_mailbox_counters_delete',
  truncate: 'messages_mailbox_counters_truncate',
} as const;

export const MAILBOX_COUNTERS_FUNCTION_DDL = `CREATE FUNCTION ${MAILBOX_COUNTERS_FUNCTION}() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ids text[];
  owners text[];
  totals integer[];
  unseens integer[];
  bytes bigint[];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    UPDATE mailboxes SET total_messages = 0, unseen_messages = 0, size_bytes = 0
    WHERE total_messages IS DISTINCT FROM 0
       OR unseen_messages IS DISTINCT FROM 0
       OR size_bytes IS DISTINCT FROM 0;
    RETURN NULL;
  END IF;

  -- One row per (folder, owner) this statement changed: what it adds to each
  -- counter. Only rows whose user_id is the folder's owner count, as in the
  -- aggregate the counters replace (messages where user_id = $1).
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(d.mailbox_id), array_agg(d.user_id), array_agg(d.total),
           array_agg(d.unseen), array_agg(d.bytes)
    INTO ids, owners, totals, unseens, bytes
    FROM (
      SELECT mailbox_id, user_id,
             count(*)::integer AS total,
             (count(*) FILTER (WHERE NOT seen))::integer AS unseen,
             sum(size)::bigint AS bytes
      FROM new_rows
      GROUP BY mailbox_id, user_id
    ) d;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(d.mailbox_id), array_agg(d.user_id), array_agg(d.total),
           array_agg(d.unseen), array_agg(d.bytes)
    INTO ids, owners, totals, unseens, bytes
    FROM (
      SELECT mailbox_id, user_id,
             -(count(*)::integer) AS total,
             -((count(*) FILTER (WHERE NOT seen))::integer) AS unseen,
             -(sum(size)::bigint) AS bytes
      FROM old_rows
      GROUP BY mailbox_id, user_id
    ) d;
  ELSE
    SELECT array_agg(d.mailbox_id), array_agg(d.user_id), array_agg(d.total),
           array_agg(d.unseen), array_agg(d.bytes)
    INTO ids, owners, totals, unseens, bytes
    FROM (
      SELECT c.mailbox_id, c.user_id,
             sum(c.total)::integer AS total,
             sum(c.unseen)::integer AS unseen,
             sum(c.bytes)::bigint AS bytes
      FROM (
        SELECT mailbox_id, user_id, 1 AS total, CASE WHEN seen THEN 0 ELSE 1 END AS unseen,
               size AS bytes
        FROM new_rows
        UNION ALL
        SELECT mailbox_id, user_id, -1, CASE WHEN seen THEN 0 ELSE -1 END, -size
        FROM old_rows
      ) c
      GROUP BY c.mailbox_id, c.user_id
      HAVING sum(c.total) <> 0 OR sum(c.unseen) <> 0 OR sum(c.bytes) <> 0
    ) d;
  END IF;

  IF ids IS NULL THEN
    RETURN NULL;
  END IF;

  -- Lock in id order first, so two statements touching the same folders in a
  -- different order queue instead of deadlocking.
  PERFORM 1
  FROM mailboxes AS m
  JOIN unnest(ids, owners) AS d(id, user_id) ON d.id = m.id AND d.user_id = m.user_id
  ORDER BY m.id
  FOR NO KEY UPDATE OF m;

  UPDATE mailboxes AS m
  SET total_messages = m.total_messages + d.total,
      unseen_messages = m.unseen_messages + d.unseen,
      size_bytes = m.size_bytes + d.bytes
  FROM unnest(ids, owners, totals, unseens, bytes) AS d(id, user_id, total, unseen, bytes)
  WHERE m.id = d.id AND m.user_id = d.user_id;

  RETURN NULL;
END;
$$;`;

/** `CREATE TRIGGER` for each event, in the shape the migration carries. */
export const MAILBOX_COUNTERS_TRIGGER_DDL = [
  `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.insert}
AFTER INSERT ON ${MAILBOX_COUNTERS_SOURCE_TABLE}
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION ${MAILBOX_COUNTERS_FUNCTION}();`,
  `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.update}
AFTER UPDATE ON ${MAILBOX_COUNTERS_SOURCE_TABLE}
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION ${MAILBOX_COUNTERS_FUNCTION}();`,
  `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.delete}
AFTER DELETE ON ${MAILBOX_COUNTERS_SOURCE_TABLE}
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION ${MAILBOX_COUNTERS_FUNCTION}();`,
  `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.truncate}
AFTER TRUNCATE ON ${MAILBOX_COUNTERS_SOURCE_TABLE}
FOR EACH STATEMENT EXECUTE FUNCTION ${MAILBOX_COUNTERS_FUNCTION}();`,
] as const;
