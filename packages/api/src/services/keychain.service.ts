/**
 * The Oxy Keychain's storage (ADR 0063, `docs/identity/keychain.md`).
 *
 * Every write runs in ONE transaction that first locks the account's vault
 * row (`SELECT … FOR UPDATE`): the roster head, the key generation and the
 * item counter all live on that row, so two writers never interleave. A second
 * roster append that raced the first reads the new head once the lock is free
 * and is refused `409 KEYCHAIN_ROSTER_CONFLICT`; a stale item write is refused
 * `409 KEYCHAIN_ITEM_CONFLICT`. Nothing is lost and nothing is half written.
 *
 * Who is the caller: the live member BOUND TO THE CALLER'S DEVICE SESSION,
 * found by `device_session_id`, never by an id the request names. A member
 * whose device session ended (`device_session_id` set NULL, "orphaned") is
 * nobody's, so it is served nothing.
 *
 * Logs carry ids and counts only: never a body, ciphertext, key, signature,
 * nonce or member name.
 */

import { and, asc, count, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  KEYCHAIN_ERROR_CODES,
  KEYCHAIN_LIMITS,
  KEYCHAIN_RECOVERY,
  type KeychainEnrollment,
  type KeychainEntry,
  type KeychainItem,
  type KeychainMember,
  type KeychainRecoveryKeys,
  type KeychainStateResponse,
  type KeychainWrap,
} from '@oxy.so/contracts';
import { isUniqueViolation } from '@oxy.so/db';
import { canonicalize } from '@oxy.so/protocol';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import {
  keychainEnrollments,
  keychainItems,
  keychainMembers,
  keychainRosterEntries,
  keychainVaults,
  keychainWraps,
} from '../db/schema/keychain';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
import {
  type AppliedAppend,
  type ParsedEntry,
  type RosterState,
  applyEntries,
  assertUsableKeys,
  enrollmentCommitment,
  liveMemberIds,
  requireWraps,
  rosterInvalid,
  sameBase64Url,
  verifyGenesis,
  limitReached,
} from './keychainRoster';

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                  */
/* -------------------------------------------------------------------------- */

function noVault(): ApiError {
  return new ApiError(404, 'This account has no keychain.', KEYCHAIN_ERROR_CODES.notFound);
}

function notMember(): ApiError {
  return new ApiError(
    403,
    'This device is not one of the keychain’s devices.',
    KEYCHAIN_ERROR_CODES.notMember,
  );
}

function enrollmentNotFound(): ApiError {
  return new ApiError(
    404,
    'That request to join the keychain does not exist.',
    KEYCHAIN_ERROR_CODES.enrollmentNotFound,
  );
}

function enrollmentExpired(): ApiError {
  return new ApiError(
    410,
    'That request to join the keychain expired. Ask again from the new device.',
    KEYCHAIN_ERROR_CODES.enrollmentExpired,
  );
}

function enrollmentState(message: string): ApiError {
  return new ApiError(409, message, KEYCHAIN_ERROR_CODES.enrollmentState);
}

function alreadyMember(): ApiError {
  return new ApiError(
    409,
    'This device is already one of the keychain’s devices.',
    KEYCHAIN_ERROR_CODES.alreadyMember,
  );
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

type VaultRow = typeof keychainVaults.$inferSelect;

const VAULT_COLUMNS = {
  id: keychainVaults.id,
  accountId: keychainVaults.accountId,
  genesisHash: keychainVaults.genesisHash,
  rosterSeq: keychainVaults.rosterSeq,
  rosterHead: keychainVaults.rosterHead,
  generation: keychainVaults.generation,
  revision: keychainVaults.revision,
  createdAt: keychainVaults.createdAt,
  updatedAt: keychainVaults.updatedAt,
} as const;

async function readVault(db: DatabaseOrTransaction, accountId: string): Promise<VaultRow | null> {
  const [row] = await db
    .select(VAULT_COLUMNS)
    .from(keychainVaults)
    .where(eq(keychainVaults.accountId, accountId))
    .limit(1);
  return row ?? null;
}

/** The account's vault, locked for the rest of the transaction. */
async function lockVault(tx: DatabaseOrTransaction, accountId: string): Promise<VaultRow> {
  const [row] = await tx
    .select(VAULT_COLUMNS)
    .from(keychainVaults)
    .where(eq(keychainVaults.accountId, accountId))
    .for('update')
    .limit(1);
  if (!row) throw noVault();
  return row;
}

interface CallerMember {
  memberId: string;
  signingKey: string;
}

/** The live member bound to `deviceSessionId`, or `null`. */
async function memberOfSession(
  db: DatabaseOrTransaction,
  vaultId: string,
  deviceSessionId: string,
): Promise<CallerMember | null> {
  const [row] = await db
    .select({ memberId: keychainMembers.memberId, signingKey: keychainMembers.signingKey })
    .from(keychainMembers)
    .where(
      and(
        eq(keychainMembers.vaultId, vaultId),
        eq(keychainMembers.deviceSessionId, deviceSessionId),
        isNull(keychainMembers.removedSeq),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function requireMember(
  db: DatabaseOrTransaction,
  vaultId: string,
  deviceSessionId: string,
): Promise<CallerMember> {
  const member = await memberOfSession(db, vaultId, deviceSessionId);
  if (!member) throw notMember();
  return member;
}

/** The roster at the vault's head, rebuilt from the stored members and entries. */
async function loadRosterState(tx: DatabaseOrTransaction, vault: VaultRow): Promise<RosterState> {
  const members = await tx
    .select({
      memberId: keychainMembers.memberId,
      signingKey: keychainMembers.signingKey,
      boxKey: keychainMembers.boxKey,
      removedSeq: keychainMembers.removedSeq,
    })
    .from(keychainMembers)
    .where(eq(keychainMembers.vaultId, vault.id));
  // The current recovery keys: the newest entry that set them.
  const [recoveryEntry] = await tx
    .select({ body: keychainRosterEntries.body })
    .from(keychainRosterEntries)
    .where(
      and(
        eq(keychainRosterEntries.vaultId, vault.id),
        inArray(keychainRosterEntries.op, ['genesis', 'recovery']),
      ),
    )
    .orderBy(sql`${keychainRosterEntries.seq} desc`)
    .limit(1);
  if (!recoveryEntry) throw new Error('keychain: a vault without a genesis entry');
  const recovery = (JSON.parse(recoveryEntry.body) as { recovery: KeychainRecoveryKeys }).recovery;
  return {
    vaultId: vault.id,
    seq: vault.rosterSeq,
    head: vault.rosterHead,
    generation: vault.generation,
    recovery,
    members: new Map(
      members.map((member) => [
        member.memberId,
        {
          signingKey: member.signingKey,
          boxKey: member.boxKey,
          live: member.removedSeq === null,
        },
      ]),
    ),
  };
}

const EMPTY_STATE: KeychainStateResponse = { vault: null, roster: [], members: [], self: null };

/** `GET /keychain`'s answer, read through `db` (a write's own transaction, or a snapshot). */
async function stateOf(
  db: DatabaseOrTransaction,
  accountId: string,
  deviceSessionId: string,
): Promise<KeychainStateResponse> {
  const vault = await readVault(db, accountId);
  if (!vault) return EMPTY_STATE;
  const roster = await db
    .select({ body: keychainRosterEntries.body, signatures: keychainRosterEntries.signatures })
    .from(keychainRosterEntries)
    .where(eq(keychainRosterEntries.vaultId, vault.id))
    .orderBy(asc(keychainRosterEntries.seq));
  const members = await db
    .select({
      memberId: keychainMembers.memberId,
      deviceSessionId: keychainMembers.deviceSessionId,
      removedSeq: keychainMembers.removedSeq,
    })
    .from(keychainMembers)
    .where(eq(keychainMembers.vaultId, vault.id))
    .orderBy(asc(keychainMembers.addedSeq));
  const self = members.find(
    (member) => member.removedSeq === null && member.deviceSessionId === deviceSessionId,
  );
  return {
    vault: {
      id: vault.id,
      genesisHash: vault.genesisHash,
      rosterSeq: vault.rosterSeq,
      rosterHead: vault.rosterHead,
      generation: vault.generation,
      revision: vault.revision,
    },
    roster: roster.map((entry) => ({ body: entry.body, signatures: entry.signatures })),
    members: members.map((member) => ({
      id: member.memberId,
      orphaned: member.deviceSessionId === null,
      removed: member.removedSeq !== null,
    })),
    self: self?.memberId ?? null,
  };
}

/** `GET /keychain`: one consistent snapshot of the vault, its roster and its members. */
export async function readKeychainState(
  accountId: string,
  deviceSessionId: string,
): Promise<KeychainStateResponse> {
  return getDb().transaction((tx) => stateOf(tx, accountId, deviceSessionId), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

type WrapRow = Pick<
  typeof keychainWraps.$inferSelect,
  'recipient' | 'generation' | 'epk' | 'nonce' | 'ciphertext' | 'signer' | 'signature'
>;

const WRAP_COLUMNS = {
  recipient: keychainWraps.recipient,
  generation: keychainWraps.generation,
  epk: keychainWraps.epk,
  nonce: keychainWraps.nonce,
  ciphertext: keychainWraps.ciphertext,
  signer: keychainWraps.signer,
  signature: keychainWraps.signature,
} as const;

function toWrap(row: WrapRow): KeychainWrap {
  return {
    recipient: row.recipient,
    generation: row.generation,
    epk: row.epk,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    signer: row.signer,
    signature: row.signature,
  };
}

async function wrapFor(
  db: DatabaseOrTransaction,
  vaultId: string,
  recipient: string,
): Promise<KeychainWrap | null> {
  const [row] = await db
    .select(WRAP_COLUMNS)
    .from(keychainWraps)
    .where(and(eq(keychainWraps.vaultId, vaultId), eq(keychainWraps.recipient, recipient)))
    .limit(1);
  return row ? toWrap(row) : null;
}

/** `GET /keychain/wrap`: the caller's own member's wrap, and nobody else's. */
export async function readOwnWrap(
  accountId: string,
  deviceSessionId: string,
): Promise<KeychainWrap> {
  const db = getDb();
  const vault = await readVault(db, accountId);
  if (!vault) throw noVault();
  // Answered 404, not 403: there is no wrap for this device (keychain.md).
  const member = await memberOfSession(db, vault.id, deviceSessionId);
  const wrap = member ? await wrapFor(db, vault.id, member.memberId) : null;
  if (!wrap) {
    throw new ApiError(
      404,
      'This device is not one of the keychain’s devices.',
      KEYCHAIN_ERROR_CODES.notMember,
    );
  }
  return wrap;
}

/** `GET /keychain/recovery`: the recovery wrap. It opens only with the recovery key. */
export async function readRecoveryWrap(accountId: string): Promise<KeychainWrap> {
  const db = getDb();
  const vault = await readVault(db, accountId);
  if (!vault) throw noVault();
  const wrap = await wrapFor(db, vault.id, KEYCHAIN_RECOVERY);
  if (!wrap) throw noVault();
  return wrap;
}

/* -------------------------------------------------------------------------- */
/*  Roster writes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Store verified entries and the wraps they came with, move the vault's head,
 * and bind each added member to its device session. `bindings` names, for
 * every added member, the session the SERVER decided it belongs to.
 */
async function persistAppend(
  tx: DatabaseOrTransaction,
  vaultId: string,
  append: Pick<AppliedAppend, 'entries' | 'state'>,
  wraps: KeychainWrap[],
  bindings: ReadonlyMap<string, string>,
): Promise<void> {
  const { entries, state } = append;
  await tx.insert(keychainRosterEntries).values(
    entries.map((entry) => ({
      vaultId,
      seq: entry.body.seq,
      hash: entry.hash,
      op: entry.body.op,
      body: entry.raw,
      signatures: entry.signatures,
    })),
  );
  for (const entry of entries) {
    const { body } = entry;
    if (body.op === 'genesis' || body.op === 'add') {
      const deviceSessionId = bindings.get(body.member.id);
      if (!deviceSessionId) throw new Error('keychain: an added member without a device session');
      await tx.insert(keychainMembers).values({
        vaultId,
        memberId: body.member.id,
        deviceSessionId,
        name: body.member.name,
        platform: body.member.platform,
        signingKey: body.member.signingKey,
        boxKey: body.member.boxKey,
        addedSeq: body.seq,
      });
    } else if (body.op === 'remove') {
      await tx
        .update(keychainMembers)
        .set({ removedSeq: body.seq })
        .where(
          and(eq(keychainMembers.vaultId, vaultId), eq(keychainMembers.memberId, body.memberId)),
        );
      // A removed member is sealed nothing more, and keeps nothing it could fetch.
      await tx
        .delete(keychainWraps)
        .where(and(eq(keychainWraps.vaultId, vaultId), eq(keychainWraps.recipient, body.memberId)));
    }
  }
  for (const wrap of wraps) {
    const values = {
      generation: wrap.generation,
      signer: wrap.signer,
      epk: wrap.epk,
      nonce: wrap.nonce,
      ciphertext: wrap.ciphertext,
      signature: wrap.signature,
    };
    await tx
      .insert(keychainWraps)
      .values({ vaultId, recipient: wrap.recipient, ...values })
      .onConflictDoUpdate({
        target: [keychainWraps.vaultId, keychainWraps.recipient],
        set: values,
      });
  }
  await tx
    .update(keychainVaults)
    .set({ rosterSeq: state.seq, rosterHead: state.head, generation: state.generation })
    .where(eq(keychainVaults.id, vaultId));
}

function opsOf(entries: ParsedEntry[]): string {
  return entries.map((entry) => entry.body.op).join(',');
}

/** A member could not be bound: its device session is already a live member's. */
function rethrowBinding(error: unknown): never {
  if (isUniqueViolation(error, 'keychain_members_live_device_session_key')) throw alreadyMember();
  throw error;
}

/**
 * `POST /keychain`: make the account's vault from its genesis entry, the
 * member's wrap and the recovery wrap (both generation 1, signed by the
 * member), binding the member to the caller's device session.
 */
export async function createKeychain(
  accountId: string,
  deviceSessionId: string,
  genesis: KeychainEntry,
  wraps: KeychainWrap[],
): Promise<KeychainStateResponse> {
  const { parsed, state } = verifyGenesis(genesis);
  if (parsed.body.op !== 'genesis')
    throw rosterInvalid('The first roster entry must be a genesis.');
  const member = parsed.body.member;
  requireWraps(wraps, {
    vaultId: state.vaultId,
    recipients: new Set([member.id, KEYCHAIN_RECOVERY]),
    generation: 1,
    signers: new Map([[member.id, member.signingKey]]),
    rotation: false,
  });
  try {
    return await getDb().transaction(async (tx) => {
      const existing = await readVault(tx, accountId);
      if (existing) throw keychainExists();
      await tx.insert(keychainVaults).values({
        id: state.vaultId,
        accountId,
        genesisHash: parsed.hash,
        rosterSeq: 0,
        rosterHead: parsed.hash,
        generation: 1,
        revision: 0,
      });
      await persistAppend(
        tx,
        state.vaultId,
        { entries: [parsed], state },
        wraps,
        new Map([[member.id, deviceSessionId]]),
      );
      logger.info('keychain.vault.created', { vaultId: state.vaultId, memberId: member.id });
      return stateOf(tx, accountId, deviceSessionId);
    });
  } catch (error) {
    // Two creations at once, or a vault id another account already holds.
    if (
      isUniqueViolation(error, 'keychain_vaults_account_id_key') ||
      isUniqueViolation(error, 'keychain_vaults_pkey')
    ) {
      throw keychainExists();
    }
    throw error;
  }
}

function keychainExists(): ApiError {
  return new ApiError(409, 'This account already has a keychain.', KEYCHAIN_ERROR_CODES.exists);
}

/**
 * `POST /keychain/roster`. Two callers:
 *
 * - a live member: any `remove`, `generation` and `recovery` entries (an `add`
 *   goes through an enrollment's approval, which binds the new member to the
 *   device that asked). Each `remove` and `recovery` is followed at once by a
 *   `generation`, and a request that moves the generation carries a wrap at it
 *   for every remaining member and `recovery`. Every wrap is sealed and signed
 *   by the caller.
 * - a device that is no member, holding the recovery key (ADR 0063 D6): exactly
 *   one `add`, signed by the recovery key alone, with the new member's wrap
 *   signed by the recovery key. The new member is bound to the caller's device
 *   session.
 */
export async function appendRoster(
  accountId: string,
  deviceSessionId: string,
  entries: KeychainEntry[],
  wraps: KeychainWrap[],
): Promise<KeychainStateResponse> {
  return getDb()
    .transaction(async (tx) => {
      const vault = await lockVault(tx, accountId);
      const base = await loadRosterState(tx, vault);
      const caller = await memberOfSession(tx, vault.id, deviceSessionId);
      const append = applyEntries(base, entries);
      const bindings = new Map<string, string>();

      if (caller) {
        if (append.added.length > 0) {
          throw rosterInvalid('A device is added by approving its request to join.');
        }
        const recipients = new Set<string>();
        // A new generation (which every `remove` and `recovery` brings) is
        // sealed to every member still in the roster and to the recovery key.
        if (append.newGeneration !== null) {
          for (const id of liveMemberIds(append.state)) recipients.add(id);
          recipients.add(KEYCHAIN_RECOVERY);
        }
        requireWraps(wraps, {
          vaultId: vault.id,
          recipients,
          generation: append.state.generation,
          signers: new Map([[caller.memberId, caller.signingKey]]),
          rotation: append.newGeneration !== null,
        });
      } else {
        const recoveryAdd =
          append.entries.length === 1 &&
          append.added.length === 1 &&
          append.entries[0].signatures.every((s) => s.signer === KEYCHAIN_RECOVERY);
        if (!recoveryAdd) throw notMember();
        const [member] = append.added;
        requireWraps(wraps, {
          vaultId: vault.id,
          recipients: new Set([member.id]),
          generation: append.state.generation,
          signers: new Map([[KEYCHAIN_RECOVERY, base.recovery.signingKey]]),
          rotation: false,
        });
        bindings.set(member.id, deviceSessionId);
      }

      await persistAppend(tx, vault.id, append, wraps, bindings);
      logger.info('keychain.roster.appended', {
        vaultId: vault.id,
        memberId: caller?.memberId ?? null,
        viaRecovery: !caller,
        ops: opsOf(append.entries),
        seq: append.state.seq,
        generation: append.state.generation,
        wraps: wraps.length,
      });
      return stateOf(tx, accountId, deviceSessionId);
    })
    .catch(rethrowBinding);
}

/* -------------------------------------------------------------------------- */
/*  Enrollments                                                               */
/* -------------------------------------------------------------------------- */

type EnrollmentRow = typeof keychainEnrollments.$inferSelect;

function toEnrollment(row: EnrollmentRow): KeychainEnrollment {
  return {
    id: row.id,
    vaultId: row.vaultId,
    member: row.member,
    commitment: row.commitment,
    approverNonce: row.approverNonce,
    approverMemberId: row.approverMemberId,
    deviceNonce: row.deviceNonce,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

const ENROLLMENT_COLUMNS = {
  id: keychainEnrollments.id,
  vaultId: keychainEnrollments.vaultId,
  deviceSessionId: keychainEnrollments.deviceSessionId,
  member: keychainEnrollments.member,
  commitment: keychainEnrollments.commitment,
  approverNonce: keychainEnrollments.approverNonce,
  approverMemberId: keychainEnrollments.approverMemberId,
  deviceNonce: keychainEnrollments.deviceNonce,
  status: keychainEnrollments.status,
  expiresAt: keychainEnrollments.expiresAt,
  createdAt: keychainEnrollments.createdAt,
  updatedAt: keychainEnrollments.updatedAt,
} as const;

async function lockEnrollment(
  tx: DatabaseOrTransaction,
  vaultId: string,
  enrollmentId: string,
): Promise<EnrollmentRow> {
  const [row] = await tx
    .select(ENROLLMENT_COLUMNS)
    .from(keychainEnrollments)
    .where(and(eq(keychainEnrollments.id, enrollmentId), eq(keychainEnrollments.vaultId, vaultId)))
    .for('update')
    .limit(1);
  if (!row) throw enrollmentNotFound();
  return row;
}

/** A pending enrollment still inside its ten minutes, else the refusal that says why not. */
function requirePending(row: EnrollmentRow, now: Date): void {
  if (row.status !== 'pending') throw enrollmentState('That request to join was already decided.');
  if (row.expiresAt.getTime() <= now.getTime()) throw enrollmentExpired();
}

/**
 * `POST /keychain/enrollments`: a device that is no member asks to join. One
 * pending request per device (a new one replaces its own older one), at most
 * four pending per vault, ten minutes each.
 */
export async function createEnrollment(
  accountId: string,
  deviceSessionId: string,
  member: KeychainMember,
  commitment: string,
  now: Date = new Date(),
): Promise<KeychainEnrollment> {
  return getDb().transaction(async (tx) => {
    const vault = await lockVault(tx, accountId);
    if (await memberOfSession(tx, vault.id, deviceSessionId)) throw alreadyMember();
    assertUsableKeys(member);
    const [known] = await tx
      .select({ memberId: keychainMembers.memberId })
      .from(keychainMembers)
      .where(and(eq(keychainMembers.vaultId, vault.id), eq(keychainMembers.memberId, member.id)))
      .limit(1);
    if (known) throw rosterInvalid('A member id is never added twice.');

    // The device's own older request is replaced, not counted.
    await tx
      .delete(keychainEnrollments)
      .where(
        and(
          eq(keychainEnrollments.vaultId, vault.id),
          eq(keychainEnrollments.deviceSessionId, deviceSessionId),
          eq(keychainEnrollments.status, 'pending'),
        ),
      );
    const [{ pending }] = await tx
      .select({ pending: count() })
      .from(keychainEnrollments)
      .where(
        and(
          eq(keychainEnrollments.vaultId, vault.id),
          eq(keychainEnrollments.status, 'pending'),
          gt(keychainEnrollments.expiresAt, now),
        ),
      );
    if (pending >= KEYCHAIN_LIMITS.maxPendingEnrollments) {
      throw limitReached('Too many devices are asking to join. Try again in a few minutes.');
    }
    const [row] = await tx
      .insert(keychainEnrollments)
      .values({
        vaultId: vault.id,
        deviceSessionId,
        member,
        commitment,
        status: 'pending',
        expiresAt: new Date(now.getTime() + KEYCHAIN_LIMITS.enrollmentTtlMs),
      })
      .returning(ENROLLMENT_COLUMNS);
    logger.info('keychain.enrollment.created', {
      vaultId: vault.id,
      enrollmentId: row.id,
      memberId: member.id,
    });
    return toEnrollment(row);
  });
}

/** `GET /keychain/enrollments`: the pending, unexpired requests, for a live member. */
export async function listEnrollments(
  accountId: string,
  deviceSessionId: string,
  now: Date = new Date(),
): Promise<KeychainEnrollment[]> {
  const db = getDb();
  const vault = await readVault(db, accountId);
  if (!vault) throw noVault();
  await requireMember(db, vault.id, deviceSessionId);
  const rows = await db
    .select(ENROLLMENT_COLUMNS)
    .from(keychainEnrollments)
    .where(
      and(
        eq(keychainEnrollments.vaultId, vault.id),
        eq(keychainEnrollments.status, 'pending'),
        gt(keychainEnrollments.expiresAt, now),
      ),
    )
    .orderBy(asc(keychainEnrollments.createdAt));
  return rows.map(toEnrollment);
}

/**
 * The enrollment, for the device that made it or a live member; anyone else
 * reads "not found" (it is not theirs to know about).
 */
async function enrollmentForCaller(
  db: DatabaseOrTransaction,
  vault: VaultRow,
  enrollmentId: string,
  deviceSessionId: string,
  lock: boolean,
): Promise<{ row: EnrollmentRow; enrolling: boolean; member: CallerMember | null }> {
  const row = lock
    ? await lockEnrollment(db, vault.id, enrollmentId)
    : (
        await db
          .select(ENROLLMENT_COLUMNS)
          .from(keychainEnrollments)
          .where(
            and(
              eq(keychainEnrollments.id, enrollmentId),
              eq(keychainEnrollments.vaultId, vault.id),
            ),
          )
          .limit(1)
      )[0];
  if (!row) throw enrollmentNotFound();
  const enrolling = row.deviceSessionId === deviceSessionId;
  const member = await memberOfSession(db, vault.id, deviceSessionId);
  if (!enrolling && !member) throw enrollmentNotFound();
  return { row, enrolling, member };
}

/** `GET /keychain/enrollments/:id`. An expired pending one answers `410`. */
export async function readEnrollment(
  accountId: string,
  deviceSessionId: string,
  enrollmentId: string,
  now: Date = new Date(),
): Promise<KeychainEnrollment> {
  const db = getDb();
  const vault = await readVault(db, accountId);
  if (!vault) throw noVault();
  const { row } = await enrollmentForCaller(db, vault, enrollmentId, deviceSessionId, false);
  if (row.status === 'pending' && row.expiresAt.getTime() <= now.getTime()) {
    throw enrollmentExpired();
  }
  return toEnrollment(row);
}

/**
 * `POST /keychain/enrollments/:id/approver-nonce`: a live member opens the
 * request, once, naming itself.
 */
export async function postApproverNonce(
  accountId: string,
  deviceSessionId: string,
  enrollmentId: string,
  memberId: string,
  approverNonce: string,
  now: Date = new Date(),
): Promise<KeychainEnrollment> {
  return getDb().transaction(async (tx) => {
    const vault = await lockVault(tx, accountId);
    const caller = await requireMember(tx, vault.id, deviceSessionId);
    if (caller.memberId !== memberId) {
      throw enrollmentState('An approver names itself.');
    }
    const row = await lockEnrollment(tx, vault.id, enrollmentId);
    requirePending(row, now);
    if (row.approverNonce !== null) {
      throw enrollmentState('Another device is already approving this request.');
    }
    const [updated] = await tx
      .update(keychainEnrollments)
      .set({ approverNonce, approverMemberId: memberId })
      .where(eq(keychainEnrollments.id, row.id))
      .returning(ENROLLMENT_COLUMNS);
    logger.info('keychain.enrollment.opened', {
      vaultId: vault.id,
      enrollmentId: row.id,
      memberId,
    });
    return toEnrollment(updated);
  });
}

/**
 * `POST /keychain/enrollments/:id/reveal`: the enrolling device reveals its
 * nonce once the approver's is posted. One try: a nonce that does not open the
 * commitment denies the request (a retry with another nonce, chosen after
 * seeing the approver's, would undo what the commitment is for).
 */
export async function revealDeviceNonce(
  accountId: string,
  deviceSessionId: string,
  enrollmentId: string,
  deviceNonce: string,
  now: Date = new Date(),
): Promise<KeychainEnrollment> {
  const outcome = await getDb().transaction(async (tx) => {
    const vault = await lockVault(tx, accountId);
    const row = await lockEnrollment(tx, vault.id, enrollmentId);
    if (row.deviceSessionId !== deviceSessionId) throw enrollmentNotFound();
    requirePending(row, now);
    if (row.approverNonce === null) {
      throw enrollmentState('No device has opened this request yet.');
    }
    if (row.deviceNonce !== null) throw enrollmentState('The nonce was already revealed.');
    const opened = sameBase64Url(
      enrollmentCommitment(vault.id, row.member, deviceNonce),
      row.commitment,
    );
    const [updated] = await tx
      .update(keychainEnrollments)
      .set(opened ? { deviceNonce } : { status: 'denied' })
      .where(eq(keychainEnrollments.id, row.id))
      .returning(ENROLLMENT_COLUMNS);
    logger.info(opened ? 'keychain.enrollment.revealed' : 'keychain.enrollment.mismatch', {
      vaultId: vault.id,
      enrollmentId: row.id,
    });
    return { opened, enrollment: toEnrollment(updated) };
  });
  if (!outcome.opened) {
    throw new ApiError(
      400,
      'The new device’s answer does not match what it committed to. The request was refused.',
      KEYCHAIN_ERROR_CODES.commitmentMismatch,
    );
  }
  return outcome.enrollment;
}

/**
 * `POST /keychain/enrollments/:id/approve`: the approver that opened the
 * request, after the reveal, appends the `add` (its member exactly the one
 * requested, signed by the approver) and the new member's wrap (sealed and
 * signed by the approver), in one transaction with the roster. The member is
 * bound to the ENROLLING device's session.
 */
export async function approveEnrollment(
  accountId: string,
  deviceSessionId: string,
  enrollmentId: string,
  entry: KeychainEntry,
  wrap: KeychainWrap,
  now: Date = new Date(),
): Promise<KeychainStateResponse> {
  return getDb()
    .transaction(async (tx) => {
      const vault = await lockVault(tx, accountId);
      const caller = await requireMember(tx, vault.id, deviceSessionId);
      const row = await lockEnrollment(tx, vault.id, enrollmentId);
      requirePending(row, now);
      if (row.approverMemberId !== caller.memberId) {
        throw enrollmentState('Only the device that opened this request approves it.');
      }
      if (row.deviceNonce === null) {
        throw enrollmentState('The new device has not answered yet.');
      }
      if (await memberOfSession(tx, vault.id, row.deviceSessionId)) throw alreadyMember();

      const base = await loadRosterState(tx, vault);
      const append = applyEntries(base, [entry]);
      const [added] = append.added;
      if (
        append.entries.length !== 1 ||
        !added ||
        canonicalize(added) !== canonicalize(row.member)
      ) {
        throw rosterInvalid('The entry adds exactly the device that asked to join.');
      }
      const signers = append.entries[0].signatures;
      if (signers.length !== 1 || signers[0].signer !== caller.memberId) {
        throw rosterInvalid('The approving device signs the entry that adds the new one.');
      }
      requireWraps([wrap], {
        vaultId: vault.id,
        recipients: new Set([added.id]),
        generation: append.state.generation,
        signers: new Map([[caller.memberId, caller.signingKey]]),
        rotation: false,
      });

      await persistAppend(tx, vault.id, append, [wrap], new Map([[added.id, row.deviceSessionId]]));
      await tx
        .update(keychainEnrollments)
        .set({ status: 'approved' })
        .where(eq(keychainEnrollments.id, row.id));
      logger.info('keychain.enrollment.approved', {
        vaultId: vault.id,
        enrollmentId: row.id,
        memberId: added.id,
        approverMemberId: caller.memberId,
        seq: append.state.seq,
      });
      return stateOf(tx, accountId, deviceSessionId);
    })
    .catch(rethrowBinding);
}

/**
 * `DELETE /keychain/enrollments/:id`: the enrolling device withdraws its
 * request (deleted), or a live member refuses it (`denied`, so the device
 * reads the answer).
 */
export async function cancelEnrollment(
  accountId: string,
  deviceSessionId: string,
  enrollmentId: string,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const vault = await lockVault(tx, accountId);
    const { row, enrolling } = await enrollmentForCaller(
      tx,
      vault,
      enrollmentId,
      deviceSessionId,
      true,
    );
    if (enrolling) {
      await tx.delete(keychainEnrollments).where(eq(keychainEnrollments.id, row.id));
    } else if (row.status === 'pending') {
      await tx
        .update(keychainEnrollments)
        .set({ status: 'denied' })
        .where(eq(keychainEnrollments.id, row.id));
    }
    logger.info(enrolling ? 'keychain.enrollment.withdrawn' : 'keychain.enrollment.denied', {
      vaultId: vault.id,
      enrollmentId: row.id,
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Items                                                                     */
/* -------------------------------------------------------------------------- */

type ItemRow = Pick<
  typeof keychainItems.$inferSelect,
  'itemId' | 'revision' | 'generation' | 'nonce' | 'ciphertext' | 'deletedAt' | 'updatedAt'
>;

const ITEM_COLUMNS = {
  itemId: keychainItems.itemId,
  revision: keychainItems.revision,
  generation: keychainItems.generation,
  nonce: keychainItems.nonce,
  ciphertext: keychainItems.ciphertext,
  deletedAt: keychainItems.deletedAt,
  updatedAt: keychainItems.updatedAt,
} as const;

function toItem(row: ItemRow): KeychainItem {
  return {
    id: row.itemId,
    revision: row.revision,
    generation: row.generation,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function itemConflict(): ApiError {
  return new ApiError(
    409,
    'This item changed on another device. Read it again and retry.',
    KEYCHAIN_ERROR_CODES.itemConflict,
  );
}

function itemNotFound(): ApiError {
  return new ApiError(404, 'No such item.', KEYCHAIN_ERROR_CODES.itemNotFound);
}

/**
 * `GET /keychain/items?since=&limit=`: the changes after `since` (deletions
 * included), ascending. The vault's revision is read FIRST and the page is
 * bounded by it, so every item at or below the answer's `revision` is
 * committed and none is skipped by a client that continues from it.
 */
export async function listItems(
  accountId: string,
  deviceSessionId: string,
  since: number,
  limit: number,
): Promise<{ items: KeychainItem[]; revision: number; more: boolean }> {
  const db = getDb();
  const vault = await readVault(db, accountId);
  if (!vault) throw noVault();
  await requireMember(db, vault.id, deviceSessionId);
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(keychainItems)
    .where(
      and(
        eq(keychainItems.vaultId, vault.id),
        gt(keychainItems.revision, since),
        lte(keychainItems.revision, vault.revision),
      ),
    )
    .orderBy(asc(keychainItems.revision))
    .limit(limit + 1);
  const more = rows.length > limit;
  return { items: rows.slice(0, limit).map(toItem), revision: vault.revision, more };
}

/** Lock the vault for an item write by a live member, and check the generation. */
async function itemWriteContext(
  tx: DatabaseOrTransaction,
  accountId: string,
  deviceSessionId: string,
): Promise<{ vault: VaultRow; member: CallerMember }> {
  const vault = await lockVault(tx, accountId);
  const member = await requireMember(tx, vault.id, deviceSessionId);
  return { vault, member };
}

async function lockItem(
  tx: DatabaseOrTransaction,
  vaultId: string,
  itemId: string,
): Promise<ItemRow | null> {
  const [row] = await tx
    .select(ITEM_COLUMNS)
    .from(keychainItems)
    .where(and(eq(keychainItems.vaultId, vaultId), eq(keychainItems.itemId, itemId)))
    .for('update')
    .limit(1);
  return row ?? null;
}

async function takeRevision(tx: DatabaseOrTransaction, vault: VaultRow): Promise<number> {
  const revision = vault.revision + 1;
  await tx.update(keychainVaults).set({ revision }).where(eq(keychainVaults.id, vault.id));
  return revision;
}

/** `PUT /keychain/items/:itemId`. */
export async function putItem(
  accountId: string,
  deviceSessionId: string,
  itemId: string,
  input: { baseRevision: number | null; generation: number; nonce: string; ciphertext: string },
): Promise<KeychainItem> {
  return getDb().transaction(async (tx) => {
    const { vault, member } = await itemWriteContext(tx, accountId, deviceSessionId);
    if (input.generation > vault.generation) {
      throw new ApiError(
        400,
        'That generation of the vault key does not exist.',
        KEYCHAIN_ERROR_CODES.generationInvalid,
      );
    }
    const existing = await lockItem(tx, vault.id, itemId);
    if (
      input.baseRevision === null ? existing !== null : existing?.revision !== input.baseRevision
    ) {
      throw itemConflict();
    }
    if (!existing || existing.deletedAt !== null) {
      const [{ live }] = await tx
        .select({ live: count() })
        .from(keychainItems)
        .where(and(eq(keychainItems.vaultId, vault.id), isNull(keychainItems.deletedAt)));
      if (live >= KEYCHAIN_LIMITS.maxLiveItems) {
        throw limitReached('This keychain holds the most items it can.');
      }
    }
    const revision = await takeRevision(tx, vault);
    const values = {
      revision,
      generation: input.generation,
      nonce: input.nonce,
      ciphertext: input.ciphertext,
      deletedAt: null,
    };
    const [row] = await tx
      .insert(keychainItems)
      .values({ vaultId: vault.id, itemId, ...values })
      .onConflictDoUpdate({ target: [keychainItems.vaultId, keychainItems.itemId], set: values })
      .returning(ITEM_COLUMNS);
    logger.debug('keychain.item.written', {
      vaultId: vault.id,
      memberId: member.memberId,
      itemId,
      revision,
    });
    return toItem(row);
  });
}

/** `DELETE /keychain/items/:itemId`: a tombstone at the next revision. */
export async function deleteItem(
  accountId: string,
  deviceSessionId: string,
  itemId: string,
  baseRevision: number,
): Promise<KeychainItem> {
  return getDb().transaction(async (tx) => {
    const { vault, member } = await itemWriteContext(tx, accountId, deviceSessionId);
    const existing = await lockItem(tx, vault.id, itemId);
    if (!existing || existing.deletedAt !== null) throw itemNotFound();
    if (existing.revision !== baseRevision) throw itemConflict();
    const revision = await takeRevision(tx, vault);
    const [row] = await tx
      .update(keychainItems)
      .set({ revision, nonce: null, ciphertext: null, deletedAt: new Date() })
      .where(and(eq(keychainItems.vaultId, vault.id), eq(keychainItems.itemId, itemId)))
      .returning(ITEM_COLUMNS);
    logger.debug('keychain.item.deleted', {
      vaultId: vault.id,
      memberId: member.memberId,
      itemId,
      revision,
    });
    return toItem(row);
  });
}

/* -------------------------------------------------------------------------- */
/*  Reset                                                                     */
/* -------------------------------------------------------------------------- */

/** The account's vault id, for the reset's checks before anything is spent. */
export async function vaultIdOf(accountId: string): Promise<string> {
  const vault = await readVault(getDb(), accountId);
  if (!vault) throw noVault();
  return vault.id;
}

/**
 * Delete the vault and, by cascade, every entry, member, wrap, item and
 * enrollment under it. `beforeDelete` runs in the same transaction, under the
 * vault's lock (a root proof is burned there, so a rollback un-burns it).
 */
export async function resetKeychain(
  accountId: string,
  vaultId: string,
  beforeDelete: (tx: DatabaseOrTransaction) => Promise<void>,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const vault = await lockVault(tx, accountId);
    if (vault.id !== vaultId) throw rosterConflictOnReset();
    await beforeDelete(tx);
    await tx.delete(keychainVaults).where(eq(keychainVaults.id, vault.id));
  });
  logger.info('keychain.vault.reset', { vaultId });
}

function rosterConflictOnReset(): ApiError {
  return new ApiError(
    409,
    'The keychain was replaced while it was being reset. Try again.',
    KEYCHAIN_ERROR_CODES.rosterConflict,
  );
}
