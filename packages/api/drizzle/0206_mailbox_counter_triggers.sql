-- oxy:deploy-phase=pre
--
-- The triggers that keep mailboxes.total_messages / unseen_messages /
-- size_bytes (added by 0205) equal to the messages they count.
--
-- HAND-WRITTEN (drizzle-kit generate --custom): drizzle-kit cannot emit a
-- trigger. The authoritative text is MAILBOX_COUNTERS_FUNCTION_DDL and
-- MAILBOX_COUNTERS_TRIGGER_DDL in src/db/schema/mailboxCounters.ts, which also
-- explains the design; src/db/schema/__tests__/mailboxCounters.test.ts fails if
-- this file stops carrying that text verbatim.
--
-- WHY `pre`: the image still serving needs no code for this. Its writes to
-- messages are counted by the trigger like every other write; its reads never
-- name the new columns. Every folder that exists now reads NULL, and NULL
-- stays NULL (col = col + delta), until the backfill counts it.
--
-- ORDER: after 0205 (the columns) and before 0207 (their default of 0). A
-- folder created while writes go uncounted must stay NULL, so the default can
-- only arrive once this trigger exists.
--
-- LOCKS: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on messages, which waits for
-- and briefly blocks writers but not readers; nothing else in this file
-- touches a table. Alone in its file, as messages is hot.
CREATE FUNCTION mailbox_counters_apply() RETURNS trigger
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
$$;--> statement-breakpoint
CREATE TRIGGER messages_mailbox_counters_insert
AFTER INSERT ON messages
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION mailbox_counters_apply();--> statement-breakpoint
CREATE TRIGGER messages_mailbox_counters_update
AFTER UPDATE ON messages
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION mailbox_counters_apply();--> statement-breakpoint
CREATE TRIGGER messages_mailbox_counters_delete
AFTER DELETE ON messages
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION mailbox_counters_apply();--> statement-breakpoint
CREATE TRIGGER messages_mailbox_counters_truncate
AFTER TRUNCATE ON messages
FOR EACH STATEMENT EXECUTE FUNCTION mailbox_counters_apply();
