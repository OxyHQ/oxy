/**
 * `KeychainClient` — one device's side of the Oxy Keychain (ADR 0063).
 *
 * A platform drives it with its own {@link KeychainDeviceStore}: the SDK never
 * decides where a device's secrets live. Every answer from Oxy is verified with
 * the keychain cryptography before anything is believed or kept:
 *
 * - the roster from its genesis, against the genesis hash and the newest head
 *   this device pinned (a fork, a rewrite or a shorter history is refused);
 * - every wrap against the verified roster (its signer a current member or the
 *   current recovery key, its generation the newest), and a new keyring keeps
 *   every generation this device already holds, byte for byte;
 * - every item: it decrypts under its generation, is the item asked for, and
 *   its counter is never lower than one this device already saw;
 * - every enrollment: the member and commitment are the ones this device made
 *   or opened, and the revealed nonce opens the commitment.
 *
 * A failure throws {@link KeychainIntegrityError} and writes nothing: not to
 * the store, not to Oxy. Operations run one at a time per client.
 *
 * Reached only through `@oxy.so/core/crypto` (or `oxy.keychain.openClient`).
 */

import {
  KEYCHAIN_ERROR_CODES,
  KEYCHAIN_LIMITS,
  type KeychainEnrollment,
  type KeychainItem as KeychainItemRecord,
  type KeychainStateResponse,
  type KeychainWrap as KeychainWireWrap,
} from '@oxy.so/contracts/client';
import type { KeychainApi, KeychainResetInput } from '../../api/keychain';
import { RECOVERY } from './constants';
import {
  bytesEqual,
  fromBase64Url,
  isLowercaseUuid,
  jcs,
  keychainTimestamp,
  randomBytes,
  toBase64Url,
  toHex,
  zeroize,
} from './encoding';
import {
  generateEnrollmentNonce,
  enrollmentCommitment,
  enrollmentComparisonCode,
  verifyEnrollmentCommitment,
} from './enrollment';
import {
  KeychainConflictError,
  KeychainCryptoError,
  KeychainFormatError,
  KeychainIntegrityError,
  KeychainRosterError,
  KeychainStateError,
} from './errors';
import {
  decryptItem,
  encryptItem,
  isItemCounterAcceptable,
  type KeychainItem,
  nextItemCounter,
  validateItem,
} from './items';
import {
  deviceKeysFromSecrets,
  exportPublicKeys,
  generateDeviceKeys,
  type KeychainKeyPairs,
  zeroizeKeyPairs,
} from './keys';
import {
  deriveRecoveryKeys,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  recoveryKeyMatches,
} from './recoveryKey';
import {
  addBody,
  findMember,
  generationBody,
  genesisBody,
  type KeychainMember,
  type KeychainPlatform,
  type KeychainRecoveryPublicKeys,
  parseMember,
  recoveryBody,
  removeBody,
  type RosterEntry,
  type RosterHead,
  rosterEntryHash,
  rosterHeadOf,
  type RosterSigner,
  signRosterBody,
  type VerifiedRoster,
  verifyRoster,
} from './roster';
import {
  createKeyring,
  createWrap,
  type Keyring,
  openWrap,
  rotateKeyring,
  zeroizeKeyring,
} from './wrap';

// ─── What the platform stores ────────────────────────────────────────────────

/**
 * What this device last knew of one item: the revision it was read or written
 * at, the highest counter seen (`null` for an item only ever seen deleted), and
 * whether it is deleted. Kept after a deletion, so an older copy can never come
 * back.
 */
export interface KeychainItemCursor {
  revision: number;
  counter: number | null;
  deleted: boolean;
}

/**
 * A member device's keychain state. JSON-safe; every field marked SECRET must
 * live in the platform's secure storage (Keychain, Keystore, the OxyOS
 * keychain service's own sealed store), never in plain preferences or logs.
 */
export interface KeychainMemberRecord {
  kind: 'member';
  v: 1;
  vaultId: string;
  /** This device's member, exactly as the roster names it. */
  member: KeychainMember;
  /** SECRET. Ed25519 secret key, base64url. */
  signingSecretKey: string;
  /** SECRET. X25519 secret key, base64url. */
  boxSecretKey: string;
  /** The hash of the roster's genesis entry: the vault's identity. */
  genesisHash: string;
  /** The newest roster head this device verified. */
  head: RosterHead;
  /** SECRET. Every generation of the vault key: `{ "<g>": base64url }`. */
  keyring: Record<string, string>;
  /** The vault revision this device has synced up to. */
  revision: number;
  /** What this device knows of each item, by id. */
  items: Record<string, KeychainItemCursor>;
}

/** A device that asked to join (ADR 0063 D5) and waits for a member's approval. */
export interface KeychainJoiningRecord {
  kind: 'joining';
  v: 1;
  vaultId: string;
  enrollmentId: string;
  member: KeychainMember;
  /** SECRET. */
  signingSecretKey: string;
  /** SECRET. */
  boxSecretKey: string;
  /** SECRET until revealed: the nonce the commitment hides. */
  deviceNonce: string;
  /** The roster this device verified when it asked (trusted on first use, then pinned). */
  genesisHash: string;
  head: RosterHead;
}

export type KeychainDeviceRecord = KeychainMemberRecord | KeychainJoiningRecord;

/**
 * Where this device keeps its keychain state. The platform implements it over
 * its secure storage; `save` replaces the whole record atomically (a reader
 * never sees half of one).
 */
export interface KeychainDeviceStore {
  load(): Promise<KeychainDeviceRecord | null>;
  save(record: KeychainDeviceRecord): Promise<void>;
  clear(): Promise<void>;
}

export interface KeychainClientOptions {
  /** `oxy.keychain`. */
  api: KeychainApi;
  store: KeychainDeviceStore;
  /** The clock for item timestamps (tests). */
  now?: () => Date;
}

// ─── What the client answers ─────────────────────────────────────────────────

/** A member as a settings screen shows it. */
export interface KeychainMemberSummary {
  id: string;
  name: string;
  platform: KeychainPlatform;
  /** This device. */
  self: boolean;
  /** Oxy no longer serves it (the account left that device): remove it (`sweepOrphans`). */
  orphaned: boolean;
}

export type KeychainStatus =
  /** The account has no vault: `createVault`. */
  | { state: 'no_vault' }
  /** A vault exists and this device is not in it: `requestToJoin` or `joinWithRecoveryKey`. */
  | { state: 'not_member'; vaultId: string }
  /** This device asked to join and waits: `revealWhenOpened`, then `completeJoin`. */
  | { state: 'joining'; vaultId: string; enrollmentId: string }
  /** This device is a member. */
  | {
      state: 'member';
      vaultId: string;
      memberId: string;
      generation: number;
      members: KeychainMemberSummary[];
      orphanedMemberIds: string[];
    }
  /** Another device removed this one, or Oxy stopped serving it: `forget`, then join again. */
  | { state: 'removed' | 'orphaned'; vaultId: string }
  /** The vault this device was in was reset (or replaced): `forget`, then start again. */
  | { state: 'vault_gone' };

/** An item to write. `counter`, `v` and `modifiedAt` are the client's; `id` is made when absent. */
export type KeychainItemDraft = KeychainItem extends infer T
  ? T extends KeychainItem
    ? Omit<T, 'id' | 'v' | 'counter' | 'createdAt' | 'modifiedAt'> & {
        id?: string;
        createdAt?: string;
      }
    : never
  : never;

export interface KeychainSyncResult {
  /** Items written or changed since the last sync, decrypted and verified. */
  items: KeychainItem[];
  /** Ids deleted since the last sync. */
  deleted: string[];
  /** The vault revision this device is now at. */
  revision: number;
}

export interface KeychainWriteResult {
  /** What was written. */
  item: KeychainItem;
  /**
   * The newer version from another device this write replaced after a conflict
   * (last writer wins per item), so the caller can tell the person. For a login,
   * its password, when different, is kept in `passwordHistory`.
   */
  superseded: KeychainItem | null;
}

export interface KeychainDeleteResult {
  id: string;
  /** The newer version from another device this deletion replaced after a conflict. */
  superseded: KeychainItem | null;
}

/** A request to join as a member device lists it. */
export interface KeychainJoinRequest {
  id: string;
  member: { id: string; name: string; platform: KeychainPlatform };
  createdAt: string;
  expiresAt: string;
  /** A member device has already opened it (only that one can approve it). */
  opened: boolean;
}

export type KeychainJoinProgress =
  /** No member device opened the request yet. */
  | { state: 'waiting' }
  /** Show this code; the person compares it with the approving device's. */
  | { state: 'compare'; code: string }
  | { state: 'approved' }
  | { state: 'refused' };

// ─── Internals ───────────────────────────────────────────────────────────────

const MAX_WRITE_ATTEMPTS = 4;
const MAX_PASSWORD_HISTORY = 10;

function apiCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** A lowercase random (version 4) uuid. */
function randomUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function integrity(reason: ConstructorParameters<typeof KeychainIntegrityError>[0]) {
  return (message: string, detail?: unknown): KeychainIntegrityError =>
    new KeychainIntegrityError(reason, message, detail);
}

function sameMember(a: KeychainMember, b: unknown): boolean {
  try {
    return jcs(a) === jcs(parseMember(b));
  } catch {
    return false;
  }
}

function encodeKeyringRecord(keyring: Keyring): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [g, key] of keyring.keys) out[String(g)] = toBase64Url(key);
  return out;
}

function decodeKeyringRecord(record: Record<string, string>): Keyring {
  const keys = new Map<number, Uint8Array>();
  for (const [g, key] of Object.entries(record)) keys.set(Number(g), fromBase64Url(key, 32));
  let generation = 0;
  for (const g of keys.keys()) generation = Math.max(generation, g);
  if (generation < 1 || keys.size !== generation) {
    throw new KeychainFormatError('the stored keyring is not every generation from 1');
  }
  return { keys, generation };
}

function deviceKeysOf(record: {
  signingSecretKey: string;
  boxSecretKey: string;
}): KeychainKeyPairs {
  return deviceKeysFromSecrets(
    fromBase64Url(record.signingSecretKey, 32),
    fromBase64Url(record.boxSecretKey, 32),
  );
}

/** What a member device holds while an operation runs; zeroized by `release`. */
interface Session {
  record: KeychainMemberRecord;
  keys: KeychainKeyPairs;
  keyring: Keyring;
  roster: VerifiedRoster;
  state: KeychainStateResponse;
}

interface PendingVault {
  vaultId: string;
  member: KeychainMember;
  keys: KeychainKeyPairs;
  recoveryKey: Uint8Array;
  /** The genesis and first wraps, made on the first confirmation and reused by a retry. */
  prepared?: { genesis: RosterEntry; wraps: KeychainWireWrap[]; keyring: Keyring };
}

interface PendingRecoveryReplacement {
  recoveryKey: Uint8Array;
}

interface OpenJoinRequest {
  id: string;
  member: KeychainMember;
  commitment: string;
  approverNonce: Uint8Array;
  code: string | null;
}

export class KeychainClient {
  private readonly api: KeychainApi;
  private readonly store: KeychainDeviceStore;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingVault: PendingVault | null = null;
  private pendingRecovery: PendingRecoveryReplacement | null = null;
  private readonly openRequests = new Map<string, OpenJoinRequest>();

  constructor(options: KeychainClientOptions) {
    this.api = options.api;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  /** Run `task` after every operation already started (one at a time). */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Verify `state`'s roster (pinned to `pin` when given) and that Oxy's summary
   * of the vault says the same. Null when Oxy says there is no vault.
   */
  private verifyState(
    state: KeychainStateResponse,
    pin?: { vaultId: string; genesisHash: string; head: RosterHead },
  ): VerifiedRoster | null {
    if (!state.vault) {
      if (state.roster.length > 0 || state.self !== null) {
        throw integrity('summary')('Oxy answered a roster without a vault');
      }
      return null;
    }
    let roster: VerifiedRoster;
    try {
      roster = verifyRoster(
        state.roster,
        pin ? { vaultId: pin.vaultId, genesisHash: pin.genesisHash, knownHead: pin.head } : {},
      );
    } catch (error) {
      if (error instanceof KeychainRosterError) {
        if (error.reason === 'not_extension') {
          const shorter = pin !== undefined && pin.head.seq >= state.roster.length;
          throw integrity(shorter ? 'rollback' : 'fork')(
            shorter
              ? 'Oxy answered an older roster than this device verified'
              : 'Oxy answered a roster that is not an extension of the one this device verified',
            error,
          );
        }
        if (error.reason === 'genesis_mismatch') {
          throw integrity('genesis_mismatch')(
            'the roster is not of the vault this device pinned',
            error,
          );
        }
        throw integrity('roster')(`the roster does not verify: ${error.message}`, error);
      }
      throw error;
    }
    const { vault } = state;
    if (
      vault.id !== roster.vaultId ||
      vault.genesisHash !== roster.genesisHash ||
      vault.rosterSeq !== roster.head.seq ||
      vault.rosterHead !== roster.head.hash ||
      vault.generation !== roster.generation
    ) {
      throw integrity('summary')("Oxy's summary of the vault does not match its roster");
    }
    if (state.self !== null && !findMember(roster, state.self)) {
      throw integrity('summary')('Oxy names as this device a member the roster does not have');
    }
    return roster;
  }

  /**
   * The keyring at the roster's newest generation: the stored one, or the
   * device's new wrap opened and checked to keep every generation it held.
   */
  private async currentKeyring(
    record: KeychainMemberRecord,
    keys: KeychainKeyPairs,
    roster: VerifiedRoster,
  ): Promise<Keyring> {
    const stored = decodeKeyringRecord(record.keyring);
    if (stored.generation === roster.generation) return stored;
    if (stored.generation > roster.generation) {
      zeroizeKeyring(stored);
      throw integrity('rollback')('the roster names an older generation than this device holds');
    }
    let fresh: Keyring;
    try {
      const wrap = await this.api.ownWrap();
      if (wrap.recipient !== record.member.id) {
        throw new KeychainCryptoError('the wrap is not sealed to this device');
      }
      fresh = openWrap(wrap, roster, keys.boxSecretKey);
    } catch (error) {
      zeroizeKeyring(stored);
      if (error instanceof KeychainCryptoError || error instanceof KeychainFormatError) {
        throw integrity('wrap')(`this device's wrap does not verify: ${error.message}`, error);
      }
      throw error;
    }
    for (const [g, key] of stored.keys) {
      const kept = fresh.keys.get(g);
      if (!kept || !bytesEqual(kept, key)) {
        zeroizeKeyring(stored);
        zeroizeKeyring(fresh);
        throw integrity('wrap')('the new keyring does not keep the generations this device holds');
      }
    }
    zeroizeKeyring(stored);
    return fresh;
  }

  /**
   * Load this member device, read and verify the vault's state, and bring the
   * keyring to the newest generation. Throws `KeychainStateError` when this
   * device is not a serving member.
   */
  private async openSession(): Promise<Session> {
    const record = await this.store.load();
    if (!record || record.kind !== 'member') {
      throw new KeychainStateError('not_member', 'this device is not a member of the keychain');
    }
    const state = await this.api.state();
    if (!state.vault || state.vault.id !== record.vaultId) {
      throw new KeychainStateError('vault_gone', 'the vault this device was a member of is gone');
    }
    const roster = this.verifyState(state, record) as VerifiedRoster;
    if (!findMember(roster, record.member.id)) {
      throw new KeychainStateError('removed', 'another device removed this one from the keychain');
    }
    if (state.self !== record.member.id) {
      throw new KeychainStateError('orphaned', 'Oxy no longer serves this device in the keychain');
    }
    const keys = deviceKeysOf(record);
    try {
      const keyring = await this.currentKeyring(record, keys, roster);
      return { record, keys, keyring, roster, state };
    } catch (error) {
      zeroizeKeyPairs(keys);
      throw error;
    }
  }

  private release(session: Session): void {
    zeroizeKeyPairs(session.keys);
    zeroizeKeyring(session.keyring);
  }

  /** The record as the verified session now stands (head, keyring). */
  private advanced(session: Session): KeychainMemberRecord {
    return {
      ...session.record,
      head: session.roster.head,
      keyring: encodeKeyringRecord(session.keyring),
    };
  }

  private signer(session: Session): RosterSigner {
    return { signer: session.record.member.id, signingSecretKey: session.keys.signingSecretKey };
  }

  /**
   * Verify a roster write's answer: it extends the head the write was built
   * on, carries the write's own entries at their places, and names this device
   * as `self`.
   */
  private verifyWriteAnswer(
    answer: KeychainStateResponse,
    pin: { vaultId: string; genesisHash: string; head: RosterHead },
    written: RosterEntry[],
    self: string,
  ): VerifiedRoster {
    const roster = this.verifyState(answer, pin);
    if (!roster) throw integrity('answer')('Oxy answered the write without a vault');
    for (const entry of written) {
      const head = rosterHeadOf(entry);
      if (roster.hashes[head.seq] !== head.hash) {
        throw integrity('answer')("Oxy's answer does not hold the entries this device wrote");
      }
    }
    if (answer.self !== self) {
      throw integrity('answer')("Oxy's answer does not name this device as the member it wrote");
    }
    return roster;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /** Where this device stands. Reads and verifies; writes nothing. */
  status(): Promise<KeychainStatus> {
    return this.exclusive(async () => {
      const record = await this.store.load();
      const state = await this.api.state();
      if (!state.vault) {
        this.verifyState(state);
        return record ? { state: 'vault_gone' } : { state: 'no_vault' };
      }
      if (!record) {
        this.verifyState(state);
        return { state: 'not_member', vaultId: state.vault.id };
      }
      if (record.vaultId !== state.vault.id) return { state: 'vault_gone' };
      const roster = this.verifyState(state, record) as VerifiedRoster;
      if (record.kind === 'joining') {
        return { state: 'joining', vaultId: record.vaultId, enrollmentId: record.enrollmentId };
      }
      if (!findMember(roster, record.member.id))
        return { state: 'removed', vaultId: record.vaultId };
      if (state.self !== record.member.id) return { state: 'orphaned', vaultId: record.vaultId };
      const orphaned = new Set(
        state.members.filter((m) => m.orphaned && !m.removed).map((m) => m.id),
      );
      return {
        state: 'member',
        vaultId: record.vaultId,
        memberId: record.member.id,
        generation: roster.generation,
        members: roster.members.map((m) => ({
          id: m.id,
          name: m.name,
          platform: m.platform,
          self: m.id === record.member.id,
          orphaned: orphaned.has(m.id) && m.id !== record.member.id,
        })),
        orphanedMemberIds: roster.members
          .filter((m) => orphaned.has(m.id) && m.id !== record.member.id)
          .map((m) => m.id),
      };
    });
  }

  // ── Creating the vault ────────────────────────────────────────────────────

  /**
   * Prepare a new vault with this device as its first member. Returns the
   * recovery key's text, shown ONCE: nothing is sent to Oxy until the person
   * types it back with {@link confirmRecoveryKey}.
   */
  createVault(input: { deviceName: string; platform: KeychainPlatform }): Promise<{
    recoveryKey: string;
  }> {
    return this.exclusive(async () => {
      const record = await this.store.load();
      if (record?.kind === 'member') {
        throw new KeychainStateError('already_member', 'this device is already a member');
      }
      const state = await this.api.state();
      this.verifyState(state);
      if (state.vault) throw new KeychainStateError('vault_exists', 'the account has a keychain');
      this.dropPendingVault();
      const keys = generateDeviceKeys();
      const member = parseMember({
        id: randomUuid(),
        name: input.deviceName,
        platform: input.platform,
        ...exportPublicKeys(keys),
      });
      const recoveryKey = generateRecoveryKey();
      this.pendingVault = { vaultId: randomUuid(), member, keys, recoveryKey };
      return { recoveryKey: formatRecoveryKey(recoveryKey) };
    });
  }

  /**
   * The person typed the recovery key back. Completes {@link createVault} or
   * {@link replaceRecoveryKey}, whichever is waiting. A key that is not the one
   * shown throws `KeychainStateError('recovery_key_mismatch')` and the
   * operation keeps waiting.
   */
  confirmRecoveryKey(text: string): Promise<KeychainStatus> {
    return this.exclusive(async () => {
      const pending = this.pendingVault?.recoveryKey ?? this.pendingRecovery?.recoveryKey;
      if (!pending) {
        throw new KeychainStateError(
          'nothing_pending',
          'no recovery key is waiting to be confirmed',
        );
      }
      let typed: Uint8Array;
      try {
        typed = parseRecoveryKey(text);
      } catch {
        throw new KeychainStateError('recovery_key_mismatch', 'that is not the recovery key shown');
      }
      const same = bytesEqual(typed, pending);
      zeroize(typed);
      if (!same) {
        throw new KeychainStateError('recovery_key_mismatch', 'that is not the recovery key shown');
      }
      if (this.pendingVault) await this.commitVault(this.pendingVault);
      else await this.commitRecoveryReplacement(pending);
      return this.statusUnlocked();
    });
  }

  /** Forget a vault creation or recovery-key replacement waiting for its confirmation. */
  cancelRecoveryKey(): void {
    this.dropPendingVault();
    if (this.pendingRecovery) zeroize(this.pendingRecovery.recoveryKey);
    this.pendingRecovery = null;
  }

  private dropPendingVault(): void {
    if (!this.pendingVault) return;
    zeroizeKeyPairs(this.pendingVault.keys);
    zeroize(this.pendingVault.recoveryKey);
    if (this.pendingVault.prepared) zeroizeKeyring(this.pendingVault.prepared.keyring);
    this.pendingVault = null;
  }

  /**
   * Send the vault's genesis and first wraps. They are made once and kept
   * until the vault is confirmed, so a retry after a lost answer sends the
   * same genesis, and a `409 KEYCHAIN_EXISTS` for a vault that IS this one
   * (the first try landed) completes instead of stranding its keys.
   */
  private async commitVault(pending: PendingVault): Promise<void> {
    const { vaultId, member, keys } = pending;
    if (!pending.prepared) {
      const recovery = deriveRecoveryKeys(pending.recoveryKey);
      const keyring = createKeyring();
      try {
        const genesis = signRosterBody(
          genesisBody({ vaultId, member, recovery: exportPublicKeys(recovery) }),
          [
            { signer: member.id, signingSecretKey: keys.signingSecretKey },
            { signer: RECOVERY, signingSecretKey: recovery.signingSecretKey },
          ],
        );
        const wrapFor = (recipient: string, recipientBoxKey: string) =>
          createWrap({
            vaultId,
            recipient,
            recipientBoxKey,
            keyring,
            signer: member.id,
            signingSecretKey: keys.signingSecretKey,
          });
        const wraps = [
          wrapFor(member.id, member.boxKey),
          wrapFor(RECOVERY, toBase64Url(recovery.boxPublicKey)),
        ];
        pending.prepared = { genesis, wraps, keyring };
      } catch (error) {
        zeroizeKeyring(keyring);
        throw error;
      } finally {
        zeroizeKeyPairs(recovery);
      }
    }
    const { genesis, wraps, keyring } = pending.prepared;
    const genesisHash = rosterEntryHash(genesis.body);
    let answer: KeychainStateResponse;
    try {
      answer = await this.api.create({ genesis, wraps });
    } catch (error) {
      if (apiCode(error) !== KEYCHAIN_ERROR_CODES.exists) throw error;
      answer = await this.api.state();
      if (answer.vault?.genesisHash !== genesisHash) {
        this.dropPendingVault();
        throw new KeychainStateError('vault_exists', 'the account has a keychain');
      }
    }
    const roster = this.verifyWriteAnswer(
      answer,
      { vaultId, genesisHash, head: { seq: 0, hash: genesisHash } },
      [genesis],
      member.id,
    );
    await this.store.save({
      kind: 'member',
      v: 1,
      vaultId,
      member,
      signingSecretKey: toBase64Url(keys.signingSecretKey),
      boxSecretKey: toBase64Url(keys.boxSecretKey),
      genesisHash,
      head: roster.head,
      keyring: encodeKeyringRecord(keyring),
      revision: 0,
      items: {},
    });
    this.dropPendingVault();
  }

  // ── Joining: approval with a compared code (ADR 0063 D5) ──────────────────

  /**
   * Ask to join the account's vault from this device. A member device opens
   * the request (`openJoinRequest`), then both show a six-digit code
   * ({@link revealWhenOpened} here) for the person to compare.
   */
  requestToJoin(input: { deviceName: string; platform: KeychainPlatform }): Promise<{
    enrollmentId: string;
    expiresAt: string;
  }> {
    return this.exclusive(async () => {
      const record = await this.store.load();
      if (record?.kind === 'member') {
        throw new KeychainStateError('already_member', 'this device is already a member');
      }
      const state = await this.api.state();
      const roster = this.verifyState(state);
      if (!roster) throw new KeychainStateError('no_vault', 'the account has no keychain');
      const keys = generateDeviceKeys();
      const deviceNonce = generateEnrollmentNonce();
      try {
        const member = parseMember({
          id: randomUuid(),
          name: input.deviceName,
          platform: input.platform,
          ...exportPublicKeys(keys),
        });
        const commitment = enrollmentCommitment(roster.vaultId, member, deviceNonce);
        const enrollment = await this.api.enrollments.create({ member, commitment });
        if (
          enrollment.vaultId !== roster.vaultId ||
          !sameMember(member, enrollment.member) ||
          enrollment.commitment !== commitment ||
          enrollment.status !== 'pending'
        ) {
          throw integrity('enrollment')('Oxy answered another request to join than this one');
        }
        await this.store.save({
          kind: 'joining',
          v: 1,
          vaultId: roster.vaultId,
          enrollmentId: enrollment.id,
          member,
          signingSecretKey: toBase64Url(keys.signingSecretKey),
          boxSecretKey: toBase64Url(keys.boxSecretKey),
          deviceNonce: toBase64Url(deviceNonce),
          genesisHash: roster.genesisHash,
          head: roster.head,
        });
        return { enrollmentId: enrollment.id, expiresAt: enrollment.expiresAt };
      } finally {
        zeroizeKeyPairs(keys);
        zeroize(deviceNonce);
      }
    });
  }

  private async loadJoining(): Promise<KeychainJoiningRecord> {
    const record = await this.store.load();
    if (!record || record.kind !== 'joining') {
      throw new KeychainStateError('nothing_pending', 'this device has not asked to join');
    }
    return record;
  }

  /** The request this device made, read back and checked to be exactly it. */
  private async readOwnEnrollment(
    record: KeychainJoiningRecord,
  ): Promise<KeychainEnrollment | null> {
    let enrollment: KeychainEnrollment;
    try {
      enrollment = await this.api.enrollments.get(record.enrollmentId);
    } catch (error) {
      const code = apiCode(error);
      if (
        code === KEYCHAIN_ERROR_CODES.enrollmentExpired ||
        code === KEYCHAIN_ERROR_CODES.enrollmentNotFound
      ) {
        return null;
      }
      throw error;
    }
    const nonce = fromBase64Url(record.deviceNonce, 32);
    try {
      if (
        enrollment.id !== record.enrollmentId ||
        enrollment.vaultId !== record.vaultId ||
        !sameMember(record.member, enrollment.member) ||
        enrollment.commitment !== enrollmentCommitment(record.vaultId, record.member, nonce)
      ) {
        throw integrity('enrollment')('Oxy answered another request to join than this one');
      }
    } finally {
      zeroize(nonce);
    }
    return enrollment;
  }

  /**
   * Once a member device opened this device's request, reveal the nonce (once)
   * and return the code to show. Call again until it is not `waiting`.
   */
  revealWhenOpened(): Promise<KeychainJoinProgress> {
    return this.exclusive(async () => {
      const record = await this.loadJoining();
      let enrollment = await this.readOwnEnrollment(record);
      if (!enrollment || enrollment.status === 'denied') return { state: 'refused' };
      if (enrollment.status === 'approved') return { state: 'approved' };
      if (enrollment.approverNonce === null) return { state: 'waiting' };
      const approverNonce = enrollment.approverNonce;
      if (enrollment.deviceNonce === null) {
        try {
          enrollment = await this.api.enrollments.reveal(record.enrollmentId, {
            deviceNonce: record.deviceNonce,
          });
        } catch (error) {
          if (apiCode(error) === KEYCHAIN_ERROR_CODES.commitmentMismatch) {
            throw integrity('enrollment')('Oxy refused the nonce this device committed to', error);
          }
          throw error;
        }
        if (enrollment.approverNonce !== approverNonce) {
          throw integrity('enrollment')("Oxy changed the approving device's nonce");
        }
      }
      if (enrollment.deviceNonce !== record.deviceNonce) {
        throw integrity('enrollment')(
          'Oxy answered another nonce than the one this device revealed',
        );
      }
      const device = fromBase64Url(record.deviceNonce, 32);
      const approver = fromBase64Url(approverNonce, 32, 'approverNonce');
      try {
        const code = enrollmentComparisonCode(record.vaultId, record.member, approver, device);
        return { state: 'compare', code };
      } finally {
        zeroize(device);
      }
    });
  }

  /**
   * After the person confirmed the codes on the approving device: become a
   * member (open this device's wrap, pin the roster). `waiting` until the
   * approval lands; `refused` when it was refused or expired.
   */
  completeJoin(): Promise<KeychainJoinProgress | { state: 'joined' }> {
    return this.exclusive(async () => {
      const record = await this.loadJoining();
      const state = await this.api.state();
      if (!state.vault || state.vault.id !== record.vaultId) {
        throw new KeychainStateError('vault_gone', 'the vault this device asked to join is gone');
      }
      const roster = this.verifyState(state, record) as VerifiedRoster;
      if (state.self !== record.member.id) {
        const enrollment = await this.readOwnEnrollment(record);
        if (!enrollment || enrollment.status === 'denied') return { state: 'refused' };
        return { state: 'waiting' };
      }
      const added = findMember(roster, record.member.id);
      if (!added || !sameMember(record.member, added)) {
        throw integrity('roster')('the roster does not hold this device as it asked to join');
      }
      const keys = deviceKeysOf(record);
      let keyring: Keyring;
      try {
        const wrap = await this.api.ownWrap();
        if (wrap.recipient !== record.member.id) {
          throw new KeychainCryptoError('the wrap is not sealed to this device');
        }
        keyring = openWrap(wrap, roster, keys.boxSecretKey);
      } catch (error) {
        zeroizeKeyPairs(keys);
        if (error instanceof KeychainCryptoError || error instanceof KeychainFormatError) {
          throw integrity('wrap')(`this device's wrap does not verify: ${error.message}`, error);
        }
        throw error;
      }
      try {
        await this.store.save({
          kind: 'member',
          v: 1,
          vaultId: record.vaultId,
          member: record.member,
          signingSecretKey: record.signingSecretKey,
          boxSecretKey: record.boxSecretKey,
          genesisHash: roster.genesisHash,
          head: roster.head,
          keyring: encodeKeyringRecord(keyring),
          revision: 0,
          items: {},
        });
      } finally {
        zeroizeKeyPairs(keys);
        zeroizeKeyring(keyring);
      }
      return { state: 'joined' };
    });
  }

  /** Withdraw this device's request to join. */
  cancelJoin(): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.loadJoining();
      try {
        await this.api.enrollments.cancel(record.enrollmentId);
      } catch (error) {
        const code = apiCode(error);
        if (
          code !== KEYCHAIN_ERROR_CODES.enrollmentNotFound &&
          code !== KEYCHAIN_ERROR_CODES.notFound
        ) {
          throw error;
        }
      }
      await this.store.clear();
    });
  }

  /** The pending requests to join, for this member device to show. */
  listJoinRequests(): Promise<KeychainJoinRequest[]> {
    return this.exclusive(async () => {
      const session = await this.openSession();
      try {
        const list = await this.api.enrollments.list();
        return list
          .filter((e) => e.vaultId === session.record.vaultId && e.status === 'pending')
          .map((e) => ({
            id: e.id,
            member: { id: e.member.id, name: e.member.name, platform: e.member.platform },
            createdAt: e.createdAt,
            expiresAt: e.expiresAt,
            opened: e.approverNonce !== null,
          }));
      } finally {
        this.release(session);
      }
    });
  }

  /**
   * The person opened a request on this member device: pin the requested
   * member and its commitment, THEN post this device's nonce (the order is the
   * protocol: Oxy is bound to the new device's keys before it sees the nonce).
   * Then call {@link joinRequestCode} until the code shows.
   */
  openJoinRequest(id: string): Promise<KeychainJoinRequest> {
    return this.exclusive(async () => {
      const session = await this.openSession();
      try {
        const enrollment = await this.api.enrollments.get(id);
        if (
          enrollment.id !== id ||
          enrollment.vaultId !== session.record.vaultId ||
          enrollment.status !== 'pending' ||
          enrollment.approverNonce !== null
        ) {
          throw new KeychainStateError('join_refused', 'that request to join cannot be opened');
        }
        let member: KeychainMember;
        try {
          member = parseMember(enrollment.member);
        } catch (error) {
          throw integrity('enrollment')(
            'the requested member is not in the keychain format',
            error,
          );
        }
        const commitment = enrollment.commitment;
        const approverNonce = generateEnrollmentNonce();
        const opened = await this.api.enrollments.postApproverNonce(id, {
          memberId: session.record.member.id,
          approverNonce: toBase64Url(approverNonce),
        });
        if (
          opened.id !== id ||
          !sameMember(member, opened.member) ||
          opened.commitment !== commitment ||
          opened.approverNonce !== toBase64Url(approverNonce)
        ) {
          zeroize(approverNonce);
          throw integrity('enrollment')('Oxy answered another request to join than the one opened');
        }
        this.openRequests.set(id, { id, member, commitment, approverNonce, code: null });
        return {
          id,
          member: { id: member.id, name: member.name, platform: member.platform },
          createdAt: opened.createdAt,
          expiresAt: opened.expiresAt,
          opened: true,
        };
      } finally {
        this.release(session);
      }
    });
  }

  /**
   * The code to show for a request this device opened, once the new device
   * revealed its nonce (`null` until then). The nonce must open the commitment
   * pinned when the request was opened.
   */
  joinRequestCode(id: string): Promise<string | null> {
    return this.exclusive(async () => {
      const open = this.openRequests.get(id);
      if (!open) {
        throw new KeychainStateError('join_request_not_open', 'that request was not opened here');
      }
      const record = await this.store.load();
      if (!record || record.kind !== 'member') {
        throw new KeychainStateError('not_member', 'this device is not a member of the keychain');
      }
      const enrollment = await this.api.enrollments.get(id);
      if (enrollment.status === 'denied') {
        this.forgetOpenRequest(id);
        throw new KeychainStateError('join_refused', 'that request to join was refused');
      }
      if (enrollment.deviceNonce === null) return null;
      const deviceNonce = fromBase64Url(enrollment.deviceNonce, 32, 'deviceNonce');
      try {
        if (
          !verifyEnrollmentCommitment(record.vaultId, open.member, deviceNonce, open.commitment)
        ) {
          this.forgetOpenRequest(id);
          throw integrity('enrollment')("the new device's nonce does not open its commitment");
        }
        open.code = enrollmentComparisonCode(
          record.vaultId,
          open.member,
          open.approverNonce,
          deviceNonce,
        );
        return open.code;
      } finally {
        zeroize(deviceNonce);
      }
    });
  }

  private forgetOpenRequest(id: string): void {
    const open = this.openRequests.get(id);
    if (open) zeroize(open.approverNonce);
    this.openRequests.delete(id);
  }

  /**
   * Add the device: only after the person confirmed both screens show the same
   * code (`codeConfirmed: true`, from the control they pressed; never
   * automatic). Appends the `add` entry and the new member's wrap.
   */
  approveJoinRequest(id: string, input: { codeConfirmed: true }): Promise<void> {
    return this.exclusive(async () => {
      if (input?.codeConfirmed !== true) {
        throw new KeychainStateError('code_not_confirmed', 'the person did not confirm the code');
      }
      const open = this.openRequests.get(id);
      if (!open || open.code === null) {
        throw new KeychainStateError('join_request_not_open', 'no code was shown for that request');
      }
      const session = await this.openSession();
      try {
        const { record, roster, keyring } = session;
        const entry = signRosterBody(
          addBody({ vaultId: record.vaultId, head: roster.head, member: open.member }),
          [this.signer(session)],
        );
        const wrap = createWrap({
          vaultId: record.vaultId,
          recipient: open.member.id,
          recipientBoxKey: open.member.boxKey,
          keyring,
          signer: record.member.id,
          signingSecretKey: session.keys.signingSecretKey,
        });
        const answer = await this.api.enrollments.approve(id, { entry, wrap });
        const after = this.verifyWriteAnswer(answer, record, [entry], record.member.id);
        await this.store.save({ ...this.advanced(session), head: after.head });
        this.forgetOpenRequest(id);
      } finally {
        this.release(session);
      }
    });
  }

  /** Refuse a request to join (from a member device). */
  denyJoinRequest(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.api.enrollments.cancel(id);
      this.forgetOpenRequest(id);
    });
  }

  // ── Joining with the recovery key (ADR 0063 D6) ───────────────────────────

  /**
   * Join with the recovery key, when no member device is at hand: open the
   * recovery wrap, check its signer against the roster, and append this
   * device's `add` signed by the recovery key.
   */
  joinWithRecoveryKey(
    text: string,
    input: { deviceName: string; platform: KeychainPlatform },
  ): Promise<KeychainStatus> {
    return this.exclusive(async () => {
      const record = await this.store.load();
      if (record?.kind === 'member') {
        throw new KeychainStateError('already_member', 'this device is already a member');
      }
      let recoveryKey: Uint8Array;
      try {
        recoveryKey = parseRecoveryKey(text);
      } catch {
        throw new KeychainStateError('recovery_key_mismatch', 'that is not a recovery key');
      }
      const recovery = deriveRecoveryKeys(recoveryKey);
      zeroize(recoveryKey);
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            await this.joinByRecovery(recovery, input);
            break;
          } catch (error) {
            if (
              apiCode(error) !== KEYCHAIN_ERROR_CODES.rosterConflict ||
              attempt >= MAX_WRITE_ATTEMPTS
            ) {
              throw error;
            }
          }
        }
      } finally {
        zeroizeKeyPairs(recovery);
      }
      return this.statusUnlocked();
    });
  }

  private async joinByRecovery(
    recovery: KeychainKeyPairs,
    input: { deviceName: string; platform: KeychainPlatform },
  ): Promise<void> {
    const state = await this.api.state();
    const roster = this.verifyState(state);
    if (!roster) throw new KeychainStateError('no_vault', 'the account has no keychain');
    if (!recoveryKeyMatches(recovery, roster.recovery)) {
      throw new KeychainStateError(
        'recovery_key_mismatch',
        "that is not this keychain's recovery key",
      );
    }
    let keyring: Keyring;
    try {
      const wrap = await this.api.recoveryWrap();
      if (wrap.recipient !== RECOVERY) throw new KeychainCryptoError('not the recovery wrap');
      keyring = openWrap(wrap, roster, recovery.boxSecretKey);
    } catch (error) {
      if (error instanceof KeychainCryptoError || error instanceof KeychainFormatError) {
        throw integrity('wrap')(`the recovery wrap does not verify: ${error.message}`, error);
      }
      throw error;
    }
    const keys = generateDeviceKeys();
    try {
      const member = parseMember({
        id: randomUuid(),
        name: input.deviceName,
        platform: input.platform,
        ...exportPublicKeys(keys),
      });
      const signer = { signer: RECOVERY, signingSecretKey: recovery.signingSecretKey };
      const entry = signRosterBody(
        addBody({ vaultId: roster.vaultId, head: roster.head, member }),
        [signer],
      );
      const wrap = createWrap({
        vaultId: roster.vaultId,
        recipient: member.id,
        recipientBoxKey: member.boxKey,
        keyring,
        signer: RECOVERY,
        signingSecretKey: recovery.signingSecretKey,
      });
      const answer = await this.api.appendRoster({ entries: [entry], wraps: [wrap] });
      const after = this.verifyWriteAnswer(answer, roster, [entry], member.id);
      await this.store.save({
        kind: 'member',
        v: 1,
        vaultId: roster.vaultId,
        member,
        signingSecretKey: toBase64Url(keys.signingSecretKey),
        boxSecretKey: toBase64Url(keys.boxSecretKey),
        genesisHash: roster.genesisHash,
        head: after.head,
        keyring: encodeKeyringRecord(keyring),
        revision: 0,
        items: {},
      });
    } finally {
      zeroizeKeyPairs(keys);
      zeroizeKeyring(keyring);
    }
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  /**
   * Pull every change since this device's revision, verify and decrypt it, and
   * return the items. Nothing is kept unless the whole pull verified.
   */
  sync(): Promise<KeychainSyncResult> {
    return this.exclusive(async () => {
      const session = await this.openSession();
      try {
        return await this.pull(session);
      } finally {
        this.release(session);
      }
    });
  }

  private async pull(session: Session): Promise<KeychainSyncResult> {
    const { record, keyring } = session;
    const cursors: Record<string, KeychainItemCursor> = { ...record.items };
    const changed = new Map<string, KeychainItem>();
    const deleted = new Set<string>();
    let since = record.revision;
    let revision: number;
    for (;;) {
      const page = await this.api.items.list({ since, limit: KEYCHAIN_LIMITS.maxItemsPage });
      if (page.revision < record.revision) {
        throw integrity('rollback')("Oxy answered an older vault revision than this device's");
      }
      let last = since;
      for (const wire of page.items) {
        this.acceptItem(session, wire, last, page.revision, keyring, cursors, changed, deleted);
        last = wire.revision;
      }
      if (page.more) {
        if (page.items.length === 0)
          throw integrity('rollback')('Oxy announced more items and sent none');
        since = last;
        continue;
      }
      if (page.revision < last) throw integrity('rollback')('an item is newer than the vault');
      revision = page.revision;
      break;
    }
    await this.store.save({ ...this.advanced(session), revision, items: cursors });
    return { items: [...changed.values()], deleted: [...deleted], revision };
  }

  private acceptItem(
    session: Session,
    wire: KeychainItemRecord,
    after: number,
    revision: number,
    keyring: Keyring,
    cursors: Record<string, KeychainItemCursor>,
    changed: Map<string, KeychainItem>,
    deleted: Set<string>,
  ): void {
    if (!isLowercaseUuid(wire.id)) throw integrity('item')('an item id is not a lowercase uuid');
    if (wire.revision <= after || wire.revision > revision) {
      throw integrity('rollback')('the items are not in revision order');
    }
    const known = cursors[wire.id];
    if (wire.deletedAt !== null) {
      if (wire.nonce !== null || wire.ciphertext !== null) {
        throw integrity('item')('a deleted item carries a ciphertext');
      }
      cursors[wire.id] = {
        revision: wire.revision,
        counter: known?.counter ?? null,
        deleted: true,
      };
      changed.delete(wire.id);
      deleted.add(wire.id);
      return;
    }
    if (wire.nonce === null || wire.ciphertext === null) {
      throw integrity('item')('an item carries no ciphertext');
    }
    let item: KeychainItem;
    try {
      item = decryptItem(
        session.record.vaultId,
        wire.id,
        { generation: wire.generation, nonce: wire.nonce, ciphertext: wire.ciphertext },
        keyring,
      );
    } catch (error) {
      if (error instanceof KeychainCryptoError || error instanceof KeychainFormatError) {
        throw integrity('item')(`an item does not decrypt: ${error.message}`, error);
      }
      throw error;
    }
    if (!isItemCounterAcceptable(known?.counter ?? undefined, item.counter)) {
      throw integrity('counter')('an item is older than one this device already saw');
    }
    cursors[wire.id] = { revision: wire.revision, counter: item.counter, deleted: false };
    deleted.delete(wire.id);
    changed.set(wire.id, item);
  }

  /**
   * Write an item under the newest generation. When another device wrote it
   * first (`409`), re-read, keep the higher counter and write again: the last
   * writer wins per item, and the version it replaced is returned (a login's
   * different password is kept in its `passwordHistory`).
   */
  putItem(draft: KeychainItemDraft): Promise<KeychainWriteResult> {
    return this.exclusive(async () => {
      const id = draft.id ?? randomUuid();
      if (!isLowercaseUuid(id)) throw new KeychainFormatError('an item id is a lowercase uuid');
      let session = await this.openSession();
      let superseded: KeychainItem | null = null;
      let content: KeychainItemDraft = draft;
      try {
        for (let attempt = 1; ; attempt += 1) {
          const { record, keyring } = session;
          const cursor = record.items[id];
          if (cursor?.deleted && cursor.counter === null) {
            throw new KeychainStateError(
              'not_found',
              'that item was deleted before this device saw it',
            );
          }
          const now = keychainTimestamp(this.now());
          const createdAt = content.createdAt ?? now;
          // A clock behind the item's creation (another device's) never writes it backwards.
          let modifiedAt = now;
          if (createdAt > modifiedAt) modifiedAt = createdAt;
          const item = validateItem({
            ...content,
            id,
            v: 1,
            createdAt,
            modifiedAt,
            counter: nextItemCounter(cursor?.counter ?? undefined),
          });
          const encrypted = encryptItem(record.vaultId, item, keyring);
          try {
            const written = await this.api.items.put(id, {
              baseRevision: cursor?.revision ?? null,
              ...encrypted,
            });
            if (
              written.id !== id ||
              written.deletedAt !== null ||
              written.generation !== encrypted.generation ||
              written.nonce !== encrypted.nonce ||
              written.ciphertext !== encrypted.ciphertext ||
              (cursor && written.revision <= cursor.revision)
            ) {
              throw integrity('answer')("Oxy's answer is not the item this device wrote");
            }
            await this.store.save({
              ...this.advanced(session),
              items: {
                ...record.items,
                [id]: { revision: written.revision, counter: item.counter, deleted: false },
              },
            });
            return { item, superseded };
          } catch (error) {
            if (apiCode(error) !== KEYCHAIN_ERROR_CODES.itemConflict) throw error;
            if (attempt >= MAX_WRITE_ATTEMPTS) {
              throw new KeychainConflictError('the item kept changing on other devices; try again');
            }
          }
          // Another device wrote first: read it, merge, write again on top.
          const merged = await this.reread(session, id);
          session = merged.session;
          if (merged.remote) {
            superseded = merged.remote;
            content = mergeOnto(content, merged.remote);
          }
        }
      } finally {
        this.release(session);
      }
    });
  }

  /** After a conflict: a fresh session, pulled, with the other device's version of `id`. */
  private async reread(
    session: Session,
    id: string,
  ): Promise<{ session: Session; remote: KeychainItem | null }> {
    this.release(session);
    const fresh = await this.openSession();
    try {
      const pulled = await this.pull(fresh);
      const record = (await this.store.load()) as KeychainMemberRecord;
      const remote = pulled.items.find((item) => item.id === id) ?? null;
      return { session: { ...fresh, record }, remote };
    } catch (error) {
      this.release(fresh);
      throw error;
    }
  }

  /**
   * Delete an item (a tombstone every device syncs). When another device
   * changed it first, re-read and delete that version, returning it.
   */
  deleteItem(id: string): Promise<KeychainDeleteResult> {
    return this.exclusive(async () => {
      let session = await this.openSession();
      let superseded: KeychainItem | null = null;
      try {
        if (!session.record.items[id]) session = (await this.reread(session, id)).session;
        for (let attempt = 1; ; attempt += 1) {
          const { record } = session;
          const cursor = record.items[id];
          if (!cursor) throw new KeychainStateError('not_found', 'no such item');
          if (cursor.deleted) return { id, superseded };
          try {
            const tombstone = await this.api.items.delete(id, { baseRevision: cursor.revision });
            if (
              tombstone.id !== id ||
              tombstone.deletedAt === null ||
              tombstone.ciphertext !== null ||
              tombstone.revision <= cursor.revision
            ) {
              throw integrity('answer')("Oxy's answer is not the deletion this device wrote");
            }
            await this.store.save({
              ...this.advanced(session),
              items: {
                ...record.items,
                [id]: { revision: tombstone.revision, counter: cursor.counter, deleted: true },
              },
            });
            return { id, superseded };
          } catch (error) {
            const code = apiCode(error);
            if (
              code !== KEYCHAIN_ERROR_CODES.itemConflict &&
              code !== KEYCHAIN_ERROR_CODES.itemNotFound
            ) {
              throw error;
            }
            if (attempt >= MAX_WRITE_ATTEMPTS) {
              throw new KeychainConflictError('the item kept changing on other devices; try again');
            }
          }
          const merged = await this.reread(session, id);
          session = merged.session;
          if (merged.remote) superseded = merged.remote;
        }
      } finally {
        this.release(session);
      }
    });
  }

  // ── Membership changes with a rotation (ADR 0063 D4, D6) ──────────────────

  /**
   * Remove another member device: `remove`, a new generation of the vault key,
   * and wraps for every remaining member and the recovery key, in one request.
   * The removed device receives nothing written afterwards.
   */
  removeMember(memberId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.rotate((session) => {
        if (memberId === session.record.member.id) {
          throw new KeychainStateError(
            'cannot_remove_self',
            'a device leaves the keychain by signing out; another device removes it',
          );
        }
        if (!findMember(session.roster, memberId)) {
          throw new KeychainStateError('not_found', 'no such member');
        }
        return { remove: [memberId] };
      });
    });
  }

  /**
   * Remove every member Oxy no longer serves (the account left that device),
   * with a rotation (ADR 0063 D4). Returns the ids removed.
   */
  sweepOrphans(): Promise<string[]> {
    return this.exclusive(async () => {
      let removed: string[] = [];
      await this.rotate((session) => {
        const orphaned = new Set(
          session.state.members.filter((m) => m.orphaned && !m.removed).map((m) => m.id),
        );
        removed = session.roster.members
          .filter((m) => orphaned.has(m.id) && m.id !== session.record.member.id)
          .map((m) => m.id);
        return removed.length > 0 ? { remove: removed } : null;
      });
      return removed;
    });
  }

  /**
   * Replace the recovery key. Returns the new key's text, shown ONCE; nothing
   * changes until the person types it back with {@link confirmRecoveryKey}.
   * Then a `recovery` entry, a new generation and wraps for every member and
   * the new recovery key: the old key opens nothing written afterwards.
   */
  replaceRecoveryKey(): Promise<{ recoveryKey: string }> {
    return this.exclusive(async () => {
      const session = await this.openSession();
      this.release(session);
      this.cancelRecoveryKey();
      const recoveryKey = generateRecoveryKey();
      this.pendingRecovery = { recoveryKey };
      return { recoveryKey: formatRecoveryKey(recoveryKey) };
    });
  }

  private async commitRecoveryReplacement(recoveryKey: Uint8Array): Promise<void> {
    const recovery = deriveRecoveryKeys(recoveryKey);
    try {
      const publicKeys = exportPublicKeys(recovery);
      await this.rotate(() => ({ remove: [], recovery: publicKeys }));
    } finally {
      zeroizeKeyPairs(recovery);
    }
    zeroize(recoveryKey);
    this.pendingRecovery = null;
  }

  /**
   * Append `remove`s and/or a `recovery`, each followed by a new generation,
   * with wraps at the newest for every remaining member and the recovery key.
   * Retried on a roster conflict (another device wrote first), re-verified.
   */
  private async rotate(
    plan: (session: Session) => { remove: string[]; recovery?: KeychainRecoveryPublicKeys } | null,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const session = await this.openSession();
      const rotated: Keyring[] = [];
      try {
        const change = plan(session);
        if (!change) return;
        const { record, roster } = session;
        const signer = this.signer(session);
        const entries: RosterEntry[] = [];
        let head = roster.head;
        let keyring = session.keyring;
        const append = (body: Parameters<typeof signRosterBody>[0]) => {
          const entry = signRosterBody(body, [signer]);
          entries.push(entry);
          head = rosterHeadOf(entry);
        };
        const nextGeneration = () => {
          keyring = rotateKeyring(keyring);
          rotated.push(keyring);
          append(generationBody({ vaultId: record.vaultId, head, generation: keyring.generation }));
        };
        for (const memberId of change.remove) {
          append(removeBody({ vaultId: record.vaultId, head, memberId }));
          nextGeneration();
        }
        if (change.recovery) {
          append(recoveryBody({ vaultId: record.vaultId, head, recovery: change.recovery }));
          nextGeneration();
        }
        const removed = new Set(change.remove);
        const recipients: { id: string; boxKey: string }[] = roster.members
          .filter((m) => !removed.has(m.id))
          .map((m) => ({ id: m.id, boxKey: m.boxKey }));
        recipients.push({
          id: RECOVERY,
          boxKey: (change.recovery ?? roster.recovery).boxKey,
        });
        const wraps: KeychainWireWrap[] = recipients.map((r) =>
          createWrap({
            vaultId: record.vaultId,
            recipient: r.id,
            recipientBoxKey: r.boxKey,
            keyring,
            signer: record.member.id,
            signingSecretKey: session.keys.signingSecretKey,
          }),
        );
        let answer: KeychainStateResponse;
        try {
          answer = await this.api.appendRoster({ entries, wraps });
        } catch (error) {
          if (
            apiCode(error) === KEYCHAIN_ERROR_CODES.rosterConflict &&
            attempt < MAX_WRITE_ATTEMPTS
          ) {
            continue;
          }
          throw error;
        }
        const after = this.verifyWriteAnswer(answer, record, entries, record.member.id);
        if (after.generation !== keyring.generation) {
          throw integrity('answer')("Oxy's answer is not at the generation this device made");
        }
        await this.store.save({
          ...this.advanced(session),
          head: after.head,
          keyring: encodeKeyringRecord(keyring),
        });
        return;
      } finally {
        for (const k of rotated) zeroizeKeyring(k);
        this.release(session);
      }
    }
  }

  // ── Reset and forgetting ──────────────────────────────────────────────────

  /**
   * Reset the vault: every item, wrap and roster entry is deleted, on every
   * device, and cannot be recovered. Needs a fresh re-verification. Call it
   * only from a control the person pressed after being told so.
   */
  reset(proof: KeychainResetInput): Promise<void> {
    return this.exclusive(async () => {
      await this.api.reset(proof);
      this.cancelRecoveryKey();
      for (const id of [...this.openRequests.keys()]) this.forgetOpenRequest(id);
      await this.store.clear();
    });
  }

  /**
   * Forget this device's keychain state (after it was removed or orphaned, or
   * when the account leaves the device). Nothing is sent to Oxy.
   */
  forget(): Promise<void> {
    return this.exclusive(async () => {
      this.cancelRecoveryKey();
      for (const id of [...this.openRequests.keys()]) this.forgetOpenRequest(id);
      await this.store.clear();
    });
  }

  /** `status()` inside an operation that already holds the queue. */
  private async statusUnlocked(): Promise<KeychainStatus> {
    const record = await this.store.load();
    if (!record || record.kind !== 'member') return { state: 'no_vault' };
    const state = await this.api.state();
    if (!state.vault || state.vault.id !== record.vaultId) return { state: 'vault_gone' };
    const roster = this.verifyState(state, record) as VerifiedRoster;
    const orphaned = new Set(
      state.members.filter((m) => m.orphaned && !m.removed).map((m) => m.id),
    );
    return {
      state: 'member',
      vaultId: record.vaultId,
      memberId: record.member.id,
      generation: roster.generation,
      members: roster.members.map((m) => ({
        id: m.id,
        name: m.name,
        platform: m.platform,
        self: m.id === record.member.id,
        orphaned: orphaned.has(m.id) && m.id !== record.member.id,
      })),
      orphanedMemberIds: roster.members
        .filter((m) => orphaned.has(m.id) && m.id !== record.member.id)
        .map((m) => m.id),
    };
  }
}

/**
 * Our write on top of another device's newer version of the same item: ours
 * wins (last writer), and nothing of theirs is lost silently: a login whose
 * password differs keeps theirs in `passwordHistory`, newest first.
 */
function mergeOnto(ours: KeychainItemDraft, theirs: KeychainItem): KeychainItemDraft {
  const kept = { ...ours, createdAt: ours.createdAt ?? theirs.createdAt } as KeychainItemDraft;
  if (kept.type !== 'login' || theirs.type !== 'login') return kept;
  if (theirs.password === '' || theirs.password === kept.password) return kept;
  const history = [...kept.passwordHistory, ...theirs.passwordHistory];
  if (!history.some((h) => h.password === theirs.password)) {
    history.push({ password: theirs.password, changedAt: theirs.modifiedAt });
  }
  const seen = new Set<string>();
  const merged = history
    .filter((h) => h.password !== kept.password)
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : 0))
    .filter((h) => {
      const key = `${h.password}\u0000${h.changedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PASSWORD_HISTORY);
  return { ...kept, passwordHistory: merged };
}
