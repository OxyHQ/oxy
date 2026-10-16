/**
 * The takedown's two database-wide rules (ADR 0043 D10), in one place:
 *
 * 1. **Blocked bytes are never stored again, by anyone.** A SHA-256 on
 *    `blocked_content_hashes` is refused by every path that creates a `files`
 *    row — an upload in any of its forms, an import by URL, a copy between
 *    owners — with HTTP 451 `CONTENT_BLOCKED`. The root check is in
 *    `fileRepository.insertFile`, which every one of those paths reaches
 *    UNDER the content-hash lock (`contentHashLock.ts`); the block itself
 *    takes the same lock, so an upload either commits before the block (and
 *    is then blocked with every other row) or sees the blocklist row. The
 *    upload paths also check before they spend work, and refuse handing back
 *    an owner's existing row of those bytes, which is blocked.
 *
 * 2. **Evidence is kept while a claim is open.** Bytes an OPEN claim names —
 *    a target it resolved, or a hash it blocked — are not purged by anything:
 *    the storage-deletion worker defers a row owed for them
 *    (`accountStorageDeletion.worker.ts`), so an owner's delete, an account's
 *    or an application's deletion, or the lifecycle's purge tombstones the
 *    row but leaves the bytes for the reviewer, until the claim closes. And a
 *    blocked file is not offered as *not in use* (the owner's cleanup list)
 *    nor collected by the lifecycle sweep while one does.
 */

import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { OPEN_CONTENT_CLAIM_STATES } from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../../config/postgres';
import { blockedContentHashes } from '../../db/schema';
import { ApiError } from '../../utils/error';

/** HTTP 451: Unavailable For Legal Reasons — what a takedown is. */
export const CONTENT_BLOCKED_STATUS = 451;
export const CONTENT_BLOCKED_CODE = 'CONTENT_BLOCKED';

/** These exact bytes were taken down after a content claim and cannot be stored again. */
export class ContentBlockedError extends ApiError {
  constructor() {
    super(
      CONTENT_BLOCKED_STATUS,
      'This content was removed from Oxy after a legal claim and cannot be uploaded again.',
      CONTENT_BLOCKED_CODE,
    );
    this.name = 'ContentBlockedError';
  }
}

/** Whether these bytes are on the blocklist (by any claim). */
export async function isContentBlocked(
  sha256: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [hit] = await db
    .select({ one: sql`1` })
    .from(blockedContentHashes)
    .where(eq(blockedContentHashes.sha256, sha256))
    .limit(1);
  return hit !== undefined;
}

/** Refuse blocked bytes ({@link ContentBlockedError}). */
export async function assertContentNotBlocked(
  sha256: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (await isContentBlocked(sha256, db)) throw new ContentBlockedError();
}

/** Refuse handing back a row that is blocked: an owner's existing copy of taken-down bytes. */
export function refuseBlockedFile(file: { status: string }): void {
  if (file.status === 'blocked') throw new ContentBlockedError();
}

/** The open states as an IMMUTABLE literal list (they are a closed set from the contract). */
const OPEN_STATE_LIST = sql.raw(OPEN_CONTENT_CLAIM_STATES.map((state) => `'${state}'`).join(', '));

/**
 * `<sha256> is held as evidence`: an open claim resolved a target to these
 * bytes, or blocked them. A predicate over any expression holding a hash, so
 * the storage purge, the lifecycle sweep and the owner's "not in use" list
 * read the SAME definition.
 *
 * The subqueries spell their own tables with aliases and `sha256` must arrive
 * QUALIFIED (`qualified(files.sha256)`, or a bound value): a bare column
 * interpolated here would resolve against the subquery's own `sha256` and
 * compare it with itself (`schema/CONVENTIONS.md`, "the second guise").
 */
export function heldAsEvidence(sha256: SQL): SQL {
  return sql`(exists (select 1 from content_claim_targets held_target
      join content_claims held_claim on held_claim.id = held_target.claim_id
      where held_target.sha256 = ${sha256} and held_claim.state in (${OPEN_STATE_LIST}))
    or exists (select 1 from blocked_content_hashes held_block
      join content_claims held_claim on held_claim.id = held_block.claim_id
      where held_block.sha256 = ${sha256} and held_claim.state in (${OPEN_STATE_LIST})))`;
}

/** Whether an open claim holds these bytes as evidence. */
export async function isHeldAsEvidence(
  sha256: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db.execute<{ held: boolean }>(
    sql`select ${heldAsEvidence(sql`${sha256}`)} as held`,
  );
  return row?.held === true;
}

/** The hashes among `sha256s` still on the blocklist (by any claim). */
export async function stillBlocked(
  sha256s: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (sha256s.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ sha256: blockedContentHashes.sha256 })
    .from(blockedContentHashes)
    .where(inArray(blockedContentHashes.sha256, [...sha256s]));
  return new Set(rows.map((row) => row.sha256));
}

/** The hashes one claim blocks. */
export async function hashesBlockedByClaim(
  claimId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ sha256: blockedContentHashes.sha256 })
    .from(blockedContentHashes)
    .where(eq(blockedContentHashes.claimId, claimId))
    .orderBy(blockedContentHashes.sha256);
  return rows.map((row) => row.sha256);
}
