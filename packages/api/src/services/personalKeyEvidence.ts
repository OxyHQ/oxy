/**
 * What Oxy's OWN records prove about a key having been a person's root
 * (security review R6-5).
 *
 * `personal_identity_key_retirements` (migration 0235) records every root a
 * rotation replaces from that migration on. A root replaced BEFORE it left no
 * row: the rotation updated `users.public_key` and the identity
 * `user_auth_methods` row IN PLACE and deleted the backup, so neither keeps the
 * old key. Commons quarantines such a key in its ring until the account's key
 * history names it, and the history could not — so the key is added here, only
 * on evidence the server wrote itself, never on a client's word.
 *
 * ## The one durable source: self-issued, verified signed records
 *
 * `signed_records` rows are written only after the chain engine verified them
 * (`signedRecord.service.verifyAndStoreRecord` → `@oxy.so/protocol`
 * `verifyAndAppend` → `isAuthorizedKey`). A SELF-ISSUED record (`issuer ===
 * subject`) is accepted only when its signing key is one of the subject's
 * CURRENT verification methods, which `oxyVerificationResolver` reads from
 * Oxy's own rows at that moment: `users.public_key` and the account's
 * `identity` `user_auth_methods` keys. Such a row (`verified = true`, its
 * `user_id`, its `public_key`, `created_at` = server time) therefore proves the
 * key was that account's identity key when it was written. Custodial records
 * (issuer `OXY_DID`, signed with Oxy's key) prove nothing about the person's key
 * and are excluded by the issuer test. `CASCADE` on the account: an erased
 * account leaves no evidence, and none is needed (its keys are tombstones only
 * through the retirements table).
 *
 * ## What cannot prove it (checked, and why)
 *
 * - `auth_challenges` (`rotate_key` rows carry the replaced key): no account
 *   column, and swept at expiry with zero retention.
 * - `identity_proof_challenges` (`user_id` + the `root_public_key` linked at
 *   mint time): swept at expiry with zero retention, so only minutes-old rows
 *   exist; a pre-0235 rotation left none.
 * - `identity_link_requests`: an hour of retention after expiry.
 * - `sessions`: reference the identity method ROW (`auth_method_id`), which a
 *   rotation rewrites in place; no key column.
 * - `security_activities`: no writer records a key (sign-in, devices, profile).
 * - `account_events`, `identity_backups` (deleted by the rotation), and the
 *   `users` / `user_auth_methods` rows themselves (updated in place): no history.
 *
 * ## Exclusions
 *
 * Evidence never adds a key that is any account's live root or identity key
 * (it is not retired), was ever an organization's (ADR 0061 D2), is already in
 * another account's history (a retired root belongs to exactly one account), or
 * that ANOTHER account's records also show as its key (before 0235 a replaced
 * root was no tombstone and could be linked again elsewhere; whose coins an
 * address tree holds is then not Oxy's to decide).
 */

import { and, eq, ne, or, sql } from 'drizzle-orm';
import { isValidSecp256k1PublicKey, normalizeSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import type { DatabaseOrTransaction } from '../config/postgres';
import { personalIdentityKeyRetirements } from '../db/schema/personalIdentityKeyRetirements';
import { signedRecords } from '../db/schema/signedRecords';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { lockIdentityKeys, organizationKeyEverUsed } from './organizationKeyHistory';

/** The answer for one `(account, key)`. */
export type PersonalKeyEvidence =
  /** The key is already in THIS account's history. */
  | { kind: 'already-retired' }
  /** Oxy's records prove it; `lastSeenAt` is the latest of them. */
  | { kind: 'proven'; lastSeenAt: Date }
  /** Never added: see {@link ExclusionReason}. */
  | { kind: 'excluded'; reason: ExclusionReason }
  /** No record of Oxy's shows the key was this account's. */
  | { kind: 'unproven' };

/**
 * - `current-root`: this account's live root or identity key (not retired).
 * - `live-elsewhere`: another account's live root or identity key.
 * - `organization`: an organization's key, current or retired.
 * - `retired-elsewhere`: another account's retired root (or a deleted one's).
 * - `evidence-elsewhere`: another account's own records show the key too.
 * - `invalid`: not a secp256k1 public key.
 */
export type ExclusionReason =
  | 'current-root'
  | 'live-elsewhere'
  | 'organization'
  | 'retired-elsewhere'
  | 'evidence-elsewhere'
  | 'invalid';

/** The verified, self-issued signed records signed with one of `spellings`. */
function selfSignedWith(spellings: readonly string[]) {
  return and(
    eq(signedRecords.verified, true),
    sql`${signedRecords.envelope}->>'issuer' = ${signedRecords.envelope}->>'subject'`,
    matchesAny(signedRecords.publicKey, spellings),
  );
}

/** Every spelling a stored key column may hold for `canonical` (lower-cased). */
function spellingsOf(canonical: string): string[] {
  return [canonical, normalizeSecp256k1PublicKey(canonical, true)];
}

/** `lower(btrim(column))` is one of `spellings`. */
function matchesAny(column: unknown, spellings: readonly string[]) {
  return or(...spellings.map((spelling) => sql`lower(btrim(${column})) = ${spelling}`));
}

/** The canonical (uncompressed, lowercase) form of `publicKey`, or `null`. */
export function canonicalPersonalKey(publicKey: string): string | null {
  const trimmed = publicKey.trim();
  return isValidSecp256k1PublicKey(trimmed) ? normalizeSecp256k1PublicKey(trimmed) : null;
}

/**
 * The latest moment Oxy's own verified, self-issued signed records show
 * `publicKey` (any spelling) as `userId`'s identity key, or `null` when none do.
 */
export async function lastSelfSignedRecordAt(
  db: DatabaseOrTransaction,
  userId: string,
  canonical: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ lastSeenAt: sql<Date | string | null>`max(${signedRecords.createdAt})` })
    .from(signedRecords)
    .where(and(eq(signedRecords.userId, userId), selfSignedWith(spellingsOf(canonical))));
  const at = row?.lastSeenAt;
  if (at === null || at === undefined) return null;
  return at instanceof Date ? at : new Date(at);
}

/**
 * Whether Oxy's own records prove `publicKey` was `userId`'s root, after the
 * exclusions above. Reads only; the caller writes the history row.
 */
export async function personalKeyEvidence(
  db: DatabaseOrTransaction,
  userId: string,
  publicKey: string,
): Promise<PersonalKeyEvidence> {
  const canonical = canonicalPersonalKey(publicKey);
  if (canonical === null) return { kind: 'excluded', reason: 'invalid' };
  const spellings = spellingsOf(canonical);

  const [retired] = await db
    .select({ userId: personalIdentityKeyRetirements.userId })
    .from(personalIdentityKeyRetirements)
    .where(eq(personalIdentityKeyRetirements.publicKey, canonical))
    .limit(1);
  if (retired) {
    return retired.userId === userId
      ? { kind: 'already-retired' }
      : { kind: 'excluded', reason: 'retired-elsewhere' };
  }

  const liveRoots = await db
    .select({ id: users.id })
    .from(users)
    .where(matchesAny(users.publicKey, spellings))
    .limit(2);
  const liveMethods = await db
    .select({ userId: userAuthMethods.userId })
    .from(userAuthMethods)
    .where(
      and(
        eq(userAuthMethods.type, 'identity'),
        matchesAny(userAuthMethods.methodPublicKey, spellings),
      ),
    )
    .limit(2);
  const holders = new Set([
    ...liveRoots.map((row) => row.id),
    ...liveMethods.map((row) => row.userId),
  ]);
  if (holders.has(userId)) return { kind: 'excluded', reason: 'current-root' };
  if (holders.size > 0) return { kind: 'excluded', reason: 'live-elsewhere' };
  if (await organizationKeyEverUsed(db, canonical)) {
    return { kind: 'excluded', reason: 'organization' };
  }

  const [elsewhere] = await db
    .select({ userId: signedRecords.userId })
    .from(signedRecords)
    .where(and(ne(signedRecords.userId, userId), selfSignedWith(spellings)))
    .limit(1);
  if (elsewhere) return { kind: 'excluded', reason: 'evidence-elsewhere' };

  const lastSeenAt = await lastSelfSignedRecordAt(db, userId, canonical);
  return lastSeenAt === null ? { kind: 'unproven' } : { kind: 'proven', lastSeenAt };
}

/** What {@link backfillPersonalKeyRetirements} found; counts only, never a key or an id. */
export interface PersonalKeyBackfillReport {
  /** Distinct (personal account, key) pairs the signed records name. */
  candidates: number;
  /** Already in that account's history. */
  alreadyRetired: number;
  /** Proven and not yet in the history: inserted with `apply`, else would be. */
  proven: number;
  /** Rows actually inserted (0 without `apply`). */
  inserted: number;
  /** Excluded, by reason. */
  excluded: Record<ExclusionReason, number>;
}

/**
 * The backfill (security review R6-5; an owner step, `scripts/backfill-personal-key-retirements.ts`):
 * every key Oxy's own records prove was a PERSONAL account's root and that its
 * history lacks is added to `personal_identity_key_retirements`, under exactly
 * the claim route's rules ({@link personalKeyEvidence}). The current roots are
 * candidates too and are excluded there (`current-root`). Without `apply`
 * nothing is written. Idempotent: a second run inserts nothing.
 */
export async function backfillPersonalKeyRetirements(
  db: DatabaseOrTransaction,
  options: { apply: boolean },
): Promise<PersonalKeyBackfillReport> {
  const pairs = await db
    .selectDistinct({
      userId: signedRecords.userId,
      publicKey: sql<string>`lower(btrim(${signedRecords.publicKey}))`,
    })
    .from(signedRecords)
    .innerJoin(users, eq(users.id, signedRecords.userId))
    .where(
      and(
        eq(users.kind, 'personal'),
        eq(signedRecords.verified, true),
        sql`${signedRecords.envelope}->>'issuer' = ${signedRecords.envelope}->>'subject'`,
      ),
    );
  // One row per (account, canonical key): a key signed in two spellings is one.
  const unique = new Map<string, { userId: string; canonical: string | null }>();
  for (const pair of pairs) {
    const canonical = canonicalPersonalKey(pair.publicKey);
    unique.set(`${pair.userId}|${canonical ?? pair.publicKey}`, { userId: pair.userId, canonical });
  }
  const report: PersonalKeyBackfillReport = {
    candidates: unique.size,
    alreadyRetired: 0,
    proven: 0,
    inserted: 0,
    excluded: {
      'current-root': 0,
      'live-elsewhere': 0,
      organization: 0,
      'retired-elsewhere': 0,
      'evidence-elsewhere': 0,
      invalid: 0,
    },
  };
  for (const { userId, canonical } of unique.values()) {
    if (canonical === null) {
      report.excluded.invalid += 1;
      continue;
    }
    const evidence = await personalKeyEvidence(db, userId, canonical);
    switch (evidence.kind) {
      case 'already-retired':
        report.alreadyRetired += 1;
        break;
      case 'excluded':
        report.excluded[evidence.reason] += 1;
        break;
      case 'unproven':
        // Unreachable for a candidate (its own records name it); counted as invalid.
        report.excluded.invalid += 1;
        break;
      case 'proven': {
        report.proven += 1;
        if (!options.apply) break;
        // Decided again under the key's lock, in the insert's transaction (R7,
        // info): a re-link between the read above and the insert would make a
        // live key a retired one.
        report.inserted += await db.transaction(async (tx) => {
          await lockIdentityKeys(tx, canonical);
          const locked = await personalKeyEvidence(tx, userId, canonical);
          if (locked.kind !== 'proven') return 0;
          const inserted = await tx
            .insert(personalIdentityKeyRetirements)
            .values({ userId, publicKey: canonical, retiredAt: locked.lastSeenAt })
            .onConflictDoNothing({ target: personalIdentityKeyRetirements.publicKey })
            .returning({ id: personalIdentityKeyRetirements.id });
          return inserted.length;
        });
        break;
      }
    }
  }
  return report;
}
