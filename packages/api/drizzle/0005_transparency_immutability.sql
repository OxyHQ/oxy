-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

-- Transparency-checkpoint immutability.
--
-- HAND-WRITTEN, not generated. drizzle-kit emits tables, constraints and
-- indexes from a schema file; it cannot emit a trigger, and a CHECK constraint
-- cannot express this rule because a CHECK sees only the new row, never the old.
--
-- The authoritative text lives in the schema, as
-- `TRANSPARENCY_IMMUTABILITY_DDL` in `src/db/schema/transparencyCheckpoints.ts`,
-- so a regeneration of the table migration has something to restore this file
-- from — and `src/db/schema/__tests__/transparencyCheckpoints.test.ts` fails
-- naming the missing trigger if it is ever dropped.
--
-- What it protects: `index`, `period_end`, `tree_size`, `root` and
-- `prev_checkpoint_hash` are the five fields every co-signer signs. Mutating one
-- invalidates every signature over the checkpoint AND breaks the next
-- checkpoint's `prev_checkpoint_hash` link, silently — nothing re-verifies a
-- stored checkpoint on read. The snapshot is what inclusion proofs are served
-- against, so a rewritten leaf makes a proof fail while the server looks correct.
--
-- BEFORE UPDATE only, deliberately: an ON DELETE guard would block the child
-- CASCADE from a checkpoint delete and turn a loud, deliberate error into a
-- confusing constraint failure.

CREATE OR REPLACE FUNCTION transparency_checkpoint_body_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed text;
BEGIN
  changed := CASE
    WHEN new."index" IS DISTINCT FROM old."index" THEN 'index'
    WHEN new.period_end IS DISTINCT FROM old.period_end THEN 'period_end'
    WHEN new.tree_size IS DISTINCT FROM old.tree_size THEN 'tree_size'
    WHEN new.root IS DISTINCT FROM old.root THEN 'root'
    WHEN new.prev_checkpoint_hash IS DISTINCT FROM old.prev_checkpoint_hash THEN 'prev_checkpoint_hash'
    ELSE null
  END;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'transparency_checkpoints.% is immutable: the checkpoint body is signed and hash-linked', changed
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER transparency_checkpoints_body_immutable
BEFORE UPDATE ON transparency_checkpoints
FOR EACH ROW EXECUTE FUNCTION transparency_checkpoint_body_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transparency_checkpoint_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transparency_checkpoint_snapshot_entries is append-only: leaf % of checkpoint % was committed under a signed Merkle root', old.leaf_index, old.checkpoint_id
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER transparency_checkpoint_snapshot_entries_immutable
BEFORE UPDATE ON transparency_checkpoint_snapshot_entries
FOR EACH ROW EXECUTE FUNCTION transparency_checkpoint_snapshot_immutable();
