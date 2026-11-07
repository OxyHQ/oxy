/**
 * The Oxy Keychain (ADR 0063, `docs/identity/keychain.md`): one end-to-end
 * encrypted vault per personal account.
 *
 * Oxy stores only ciphertext, public keys, signatures and counters. Nothing in
 * these tables opens anything: the vault key is sealed to member devices' box
 * keys and to the recovery key, neither of which Oxy ever holds.
 *
 * - `keychain_vaults` — one per account, with the roster's head and the two
 *   counters (key generation, item revision) every write moves under the
 *   vault row's lock.
 * - `keychain_roster_entries` — the append-only signed membership log, kept
 *   exactly as signed (`body` is the JCS bytes the signatures cover).
 * - `keychain_members` — derived from the roster, plus the one fact that is
 *   the server's own: which device session a member is bound to. When that
 *   session ends the binding is set NULL (orphaned) and Oxy serves the member
 *   nothing more (ADR 0063 D4).
 * - `keychain_wraps` — the keyring sealed to each recipient, one row each.
 * - `keychain_items` — one ciphertext per item; a deletion is a tombstone so
 *   `since` sync sees it.
 * - `keychain_enrollments` — a device asking to join, for ten minutes.
 *
 * Everything hangs off the vault with `ON DELETE CASCADE`, and the vault off
 * the account: deleting the account (or resetting the keychain) leaves nothing.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  KEYCHAIN_ENROLLMENT_STATUSES,
  KEYCHAIN_PLATFORMS,
  KEYCHAIN_ROSTER_OPS,
  type KeychainMember,
  type KeychainSignature,
} from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { deviceSessions } from './deviceSessions';
import { users } from './users';

/** How long a finished or expired enrollment is kept so a poll reads its outcome, not a 404. */
export const KEYCHAIN_ENROLLMENT_GRACE_SECONDS = 24 * 60 * 60;

const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
const HEX64 = `'^[0-9a-f]{64}$'`;
const BYTES32 = `'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'`;
const NONCE24 = `'^[A-Za-z0-9_-]{32}$'`;
const SIGNATURE = `'^[A-Za-z0-9_-]{85}[AQgw]$'`;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const keychainVaults = pgTable(
  'keychain_vaults',
  {
    /** The client-chosen vault id: named in every signed entry, wrap and AAD. */
    id: text().primaryKey(),
    /** The account the vault belongs to; one vault each. `CASCADE`: nothing outlives the account. */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The hash of entry 0, the vault's identity. */
    genesisHash: text().notNull(),
    /** The head entry's seq. */
    rosterSeq: integer().notNull(),
    /** The head entry's hash: the next entry's `prev`. */
    rosterHead: text().notNull(),
    /** The newest vault-key generation (1, 2, …). */
    generation: integer().notNull(),
    /** The item counter: every item write takes the next value. */
    revision: bigint({ mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('keychain_vaults_account_id_key').on(t.accountId),
    check('keychain_vaults_id_check', sql`${t.id} ~ ${sql.raw(UUID)}`),
    check('keychain_vaults_genesis_hash_check', sql`${t.genesisHash} ~ ${sql.raw(HEX64)}`),
    check('keychain_vaults_roster_head_check', sql`${t.rosterHead} ~ ${sql.raw(HEX64)}`),
    check('keychain_vaults_roster_seq_check', sql`${t.rosterSeq} >= 0`),
    check('keychain_vaults_generation_check', sql`${t.generation} >= 1`),
    check('keychain_vaults_revision_check', sql`${t.revision} >= 0`),
  ],
);

export const keychainRosterEntries = pgTable(
  'keychain_roster_entries',
  {
    vaultId: text()
      .notNull()
      .references(() => keychainVaults.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    /** hex SHA-256 of `"oxy.keychain.roster.v1\n" ‖ body`. */
    hash: text().notNull(),
    op: text({ enum: KEYCHAIN_ROSTER_OPS }).notNull(),
    /** The entry without signatures, as the JCS bytes that were signed. Public keys and ids only. */
    body: text().notNull(),
    /** `[{ signer, signature }]`, as received and verified. */
    signatures: jsonb().$type<KeychainSignature[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.seq] }),
    check('keychain_roster_entries_seq_check', sql`${t.seq} >= 0`),
    check('keychain_roster_entries_hash_check', sql`${t.hash} ~ ${sql.raw(HEX64)}`),
    check(
      'keychain_roster_entries_op_check',
      sql`${t.op} in (${sql.raw(inList(KEYCHAIN_ROSTER_OPS))})`,
    ),
    check(
      'keychain_roster_entries_signatures_check',
      sql`jsonb_typeof(${t.signatures}) = 'array' and jsonb_array_length(${t.signatures}) between 1 and 2`,
    ),
  ],
);

export const keychainMembers = pgTable(
  'keychain_members',
  {
    vaultId: text()
      .notNull()
      .references(() => keychainVaults.id, { onDelete: 'cascade' }),
    /** The uuid the device chose for itself, as in the roster. */
    memberId: text().notNull(),
    /**
     * The device session the member is bound to: the server's own fact, never
     * a client's claim. `SET NULL` when that session row goes (signed out
     * everywhere, removed from the device list, account removed from the
     * machine): the member is then ORPHANED and served nothing more, and only a
     * member device can remove it from the roster.
     */
    deviceSessionId: text().references(() => deviceSessions.id, { onDelete: 'set null' }),
    /** Display only; never logged. */
    name: text().notNull(),
    platform: text({ enum: KEYCHAIN_PLATFORMS }).notNull(),
    /** Ed25519 public key, base64url. */
    signingKey: text().notNull(),
    /** X25519 public key, base64url. */
    boxKey: text().notNull(),
    /** The seq of the entry that added it (genesis: 0). */
    addedSeq: integer().notNull(),
    /** The seq of the entry that removed it; NULL while it is a member. */
    removedSeq: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.memberId] }),
    // One live member per device session and vault: the session IS the binding.
    uniqueIndex('keychain_members_live_device_session_key')
      .on(t.vaultId, t.deviceSessionId)
      .where(sql`${t.removedSeq} is null and ${t.deviceSessionId} is not null`),
    // The `SET NULL` from `device_sessions` and the caller lookup both go by session.
    index('keychain_members_device_session_id_idx').on(t.deviceSessionId),
    check('keychain_members_member_id_check', sql`${t.memberId} ~ ${sql.raw(UUID)}`),
    check(
      'keychain_members_platform_check',
      sql`${t.platform} in (${sql.raw(inList(KEYCHAIN_PLATFORMS))})`,
    ),
    check('keychain_members_signing_key_check', sql`${t.signingKey} ~ ${sql.raw(BYTES32)}`),
    check('keychain_members_box_key_check', sql`${t.boxKey} ~ ${sql.raw(BYTES32)}`),
    check(
      'keychain_members_seq_check',
      sql`${t.addedSeq} >= 0 and (${t.removedSeq} is null or ${t.removedSeq} > ${t.addedSeq})`,
    ),
  ],
);

export const keychainWraps = pgTable(
  'keychain_wraps',
  {
    vaultId: text()
      .notNull()
      .references(() => keychainVaults.id, { onDelete: 'cascade' }),
    /** A member id, or `recovery`. */
    recipient: text().notNull(),
    /** The newest generation the keyring holds. */
    generation: integer().notNull(),
    /** Who sealed and signed it: a member id, or `recovery`. */
    signer: text().notNull(),
    /** The ephemeral X25519 public key of the seal. */
    epk: text().notNull(),
    nonce: text().notNull(),
    ciphertext: text().notNull(),
    signature: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.recipient] }),
    check(
      'keychain_wraps_recipient_check',
      sql`${t.recipient} = 'recovery' or ${t.recipient} ~ ${sql.raw(UUID)}`,
    ),
    check(
      'keychain_wraps_signer_check',
      sql`${t.signer} = 'recovery' or ${t.signer} ~ ${sql.raw(UUID)}`,
    ),
    check('keychain_wraps_generation_check', sql`${t.generation} >= 1`),
    check('keychain_wraps_epk_check', sql`${t.epk} ~ ${sql.raw(BYTES32)}`),
    check('keychain_wraps_nonce_check', sql`${t.nonce} ~ ${sql.raw(NONCE24)}`),
    check('keychain_wraps_signature_check', sql`${t.signature} ~ ${sql.raw(SIGNATURE)}`),
  ],
);

export const keychainItems = pgTable(
  'keychain_items',
  {
    vaultId: text()
      .notNull()
      .references(() => keychainVaults.id, { onDelete: 'cascade' }),
    /** The client's uuid for the item, repeated inside its plaintext. */
    itemId: text().notNull(),
    /** The vault revision this write took. */
    revision: bigint({ mode: 'number' }).notNull(),
    /** The vault-key generation the ciphertext is under. */
    generation: integer().notNull(),
    /** NULL for a tombstone. */
    nonce: text(),
    /** XChaCha20-Poly1305 ciphertext with its tag, base64url. NULL for a tombstone. */
    ciphertext: text(),
    deletedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.itemId] }),
    // `GET /keychain/items?since=` reads by revision; a revision is never reused.
    unique('keychain_items_vault_id_revision_key').on(t.vaultId, t.revision),
    check('keychain_items_item_id_check', sql`${t.itemId} ~ ${sql.raw(UUID)}`),
    check('keychain_items_revision_check', sql`${t.revision} >= 1`),
    check('keychain_items_generation_check', sql`${t.generation} >= 1`),
    check(
      'keychain_items_tombstone_check',
      sql`(${t.deletedAt} is null) = (${t.ciphertext} is not null) and (${t.ciphertext} is null) = (${t.nonce} is null)`,
    ),
    check(
      'keychain_items_nonce_check',
      sql`${t.nonce} is null or ${t.nonce} ~ ${sql.raw(NONCE24)}`,
    ),
    check(
      'keychain_items_ciphertext_check',
      sql`${t.ciphertext} is null or char_length(${t.ciphertext}) <= 65536`,
    ),
  ],
);

export const keychainEnrollments = pgTable(
  'keychain_enrollments',
  {
    id: generatedId(),
    vaultId: text()
      .notNull()
      .references(() => keychainVaults.id, { onDelete: 'cascade' }),
    /** The ENROLLING device's session. `CASCADE`: a request from a device that left is void. */
    deviceSessionId: text()
      .notNull()
      .references(() => deviceSessions.id, { onDelete: 'cascade' }),
    /** The member the device asks to be: `{ id, name, platform, signingKey, boxKey }`. */
    member: jsonb().$type<KeychainMember>().notNull(),
    /** SHA-256 of the commit input (ADR 0063 D8), base64url. */
    commitment: text().notNull(),
    approverNonce: text(),
    /** The member that posted `approverNonce`, the only one that may approve. */
    approverMemberId: text(),
    deviceNonce: text(),
    status: text({ enum: KEYCHAIN_ENROLLMENT_STATUSES }).notNull().default('pending'),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('keychain_enrollments_vault_id_status_idx').on(t.vaultId, t.status),
    index('keychain_enrollments_device_session_id_idx').on(t.deviceSessionId),
    index('keychain_enrollments_expires_at_idx').on(t.expiresAt),
    check(
      'keychain_enrollments_status_check',
      sql`${t.status} in (${sql.raw(inList(KEYCHAIN_ENROLLMENT_STATUSES))})`,
    ),
    check('keychain_enrollments_commitment_check', sql`${t.commitment} ~ ${sql.raw(BYTES32)}`),
    check(
      'keychain_enrollments_approver_check',
      sql`(${t.approverNonce} is null) = (${t.approverMemberId} is null) and (${t.approverNonce} is null or ${t.approverNonce} ~ ${sql.raw(BYTES32)}) and (${t.approverMemberId} is null or ${t.approverMemberId} ~ ${sql.raw(UUID)})`,
    ),
    check(
      'keychain_enrollments_device_nonce_check',
      sql`${t.deviceNonce} is null or (${t.approverNonce} is not null and ${t.deviceNonce} ~ ${sql.raw(BYTES32)})`,
    ),
    check('keychain_enrollments_member_check', sql`jsonb_typeof(${t.member}) = 'object'`),
  ],
);
