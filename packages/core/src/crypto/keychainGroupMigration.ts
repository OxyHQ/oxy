/**
 * Commons, iOS: move every identity item out of the shared keychain group
 * into the group it belongs to, ONCE (docs/identity/ios-keychain-access-groups.md
 * "Migrating existing items", ADR 0062; round-4 review R4-6, R4-7).
 *
 * Before the split Commons listed one access group, the shared one, so every
 * item it wrote landed there — the root key, both phrases, organization keys.
 * But every Oxy app can WRITE that group too, and keychain items survive an
 * uninstall. So a value found there is adopted only when Commons can prove it
 * wrote it:
 *
 * - **Provenance.** Commons' identity marker (`./identityMarker`) lives in its
 *   own sandbox (AsyncStorage): no other app can write it and an uninstall
 *   removes it. A personal key is adopted only when it IS the key that marker
 *   records; a phrase only when it derives it. An organization key is adopted
 *   only when it equals the key this device already holds for that
 *   organization in the wallet group (R5-7): any app could write the shared
 *   copy, and the marker says nothing about organizations. No marker — a fresh
 *   install, a reinstall, a device that never ran a marker-aware Commons —
 *   adopts NOTHING from the shared group, ever.
 * - **Nothing is lost (R5-3).** A valid key or phrase that is not adopted is
 *   kept in the retired ring QUARANTINED (`./retiredKeys`: a personal entry
 *   without an owner, an organization entry flagged `quarantined`), read back,
 *   and only then deleted from the shared group. Quarantined entries reach
 *   nobody until Commons binds them against the account's own key history
 *   (`claimRetiredIdentityKeys`, `claimRetiredOrganizationKeys`), and an
 *   organization's current key comes back as its live pair
 *   (`adoptOrganizationKeyFromRing`). A Commons secret write that finds a
 *   different copy in the shared group keeps it the same way first
 *   (`setSharedCopyKeeper`).
 * - **No prompts (R5-9).** The shared group is read without user interaction
 *   (`readSharedWithoutInteraction`): another app can plant an item there that
 *   requires Face ID, and expo-secure-store's own read would prompt for it.
 * - **Development builds (R5-5)** never read, move or delete anything in the
 *   shared group: it has no dev variant, so what is there is production's.
 * - **One shot.** When a run settles, a completion record is written to the
 *   identity group (Commons only) and mirrored into the wallet group (for the
 *   Peable wallet). With it, no later run looks at the shared group and no
 *   read falls back to it (`setHolderSharedSecretFallback`,
 *   `closeWalletSharedSecretFallback`).
 * - **A different key is retired, then deleted (R4-6).** A shared copy that
 *   is a valid key but not the one being kept (a replaced root, an old backup
 *   slot, an organization's previous key, a phrase of either) is kept in the
 *   retired ring (spending only, quarantined), read back, and only then
 *   deleted from the shared group. Nothing that could hold money is
 *   destroyed, and nothing stays where every app can read it.
 *
 * Each adopted item moves by VERIFY-BEFORE-DELETE: read it from the shared
 * group, write it to its group, read it back (a pair must be healthy, a value
 * byte-identical), and only then delete the shared copy. A failure at any step
 * leaves the shared copy; the run is `incomplete`, no record is written, and
 * Commons' reads may still fall back to the shared group for exactly the
 * proven items that could not move (R5-9); a later access retries, with a
 * backoff, and the next launch resumes.
 *
 * `ensureKeychainGroupsMigrated` is awaited by every KeyManager, organization
 * key and retired-ring access in Commons, so no write of theirs can interleave
 * with a copy here. Nothing is logged but item labels and outcomes; never a
 * value.
 */
import {
  deriveSecp256k1PublicKey,
  isValidSecp256k1PrivateKey,
  normalizeSecp256k1PrivateKey,
  normalizeSecp256k1PublicKey,
} from '@oxy.so/protocol/secp256k1';
import { type ExpoSecureStoreLike, loadSecureStore } from '@oxy.so/protocol';
import { mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { logger } from '../logger';
import {
  type KeychainAccess,
  type KeychainAccessGroupName,
  type KeychainItemClass,
  type KeychainItemName,
  closeWalletSharedSecretFallback,
  keychainAccessGroupValue,
  keychainGroupFor,
  readSharedWithoutInteraction,
  resolveKeychainAccess,
  setHolderSharedSecretFallback,
  setSharedCopyKeeper,
} from '../utils/keychainAccessGroups';
import { readIdentityMarkerStrict } from './identityMarker';
import {
  ORGANIZATION_INDEX_KEYCHAIN_SERVICE,
  ORGANIZATION_INDEX_STORAGE_KEY,
  ORGANIZATION_MNEMONIC_KEYCHAIN_SERVICE,
  RECOVERY_MNEMONIC_KEYCHAIN_SERVICE,
  RECOVERY_MNEMONIC_STORAGE_KEY,
  STORAGE_KEYS,
  V2_BACKUP_KEYCHAIN_SERVICE,
  V2_PRIMARY_KEYCHAIN_SERVICE,
  V2_STORAGE_KEYS,
  organizationMnemonicName,
  organizationOfSecretItem,
  organizationPrivateKeyName,
  organizationPublicKeyName,
  parseOrganizationIndex,
  parseOrganizationIndexStrict,
  serializeOrganizationIndex,
} from './keychainItems';
import { RetiredKeyQuarantineFullError, retireIdentityKeyDuringMigration } from './retiredKeys';

/** What happened to one item (or pair) in a run. */
export type KeychainItemMigrationOutcome =
  | 'absent'
  | 'moved'
  | 'retired'
  | 'discarded'
  | 'failed'
  | 'deferred'
  /**
   * A valid key the ring may not keep now: its quarantine is full (R6-14).
   * The shared copy is LEFT where it is (never lost, never trusted), and it
   * does not keep the run from settling: a planted shared group must not make
   * every launch redo the run.
   */
  | 'over-limit';

export interface KeychainGroupMigrationReport {
  /**
   * - `not-applicable`: not Commons on a split-aware iOS build, or a
   *   development build (R5-5); nothing to move.
   * - `complete`: the completion record exists; the shared group is never
   *   read again for a secret.
   * - `incomplete`: a copy or delete failed; retried on a later access (with
   *   a backoff) and on the next launch.
   * - `deferred`: the keychain or the marker could not be read (locked);
   *   retried on the next storage access.
   */
  state: 'not-applicable' | 'complete' | 'incomplete' | 'deferred';
  /** Outcome per item label (`primary`, `phrase`, `organization-1`, …). */
  items: Record<string, KeychainItemMigrationOutcome>;
  /** Whether this device's marker vouched for the shared copies (absent before a run). */
  proven?: boolean;
}

/**
 * The completion record (identity group) and its mirror (wallet group). The
 * record also remembers whether the CURRENT personal key, and which
 * organization keys, were found in the shared group: every Oxy iOS app could
 * read those before the split ({@link getPreSplitExposure}).
 *
 * `v` is the SWEEP version (security review R6-6/R6-3). A `v: 1` record says
 * only that some earlier core settled a run, and core 7.32 (Commons 1.8, 1.9)
 * settled one after adopting nothing on a device without the identity marker
 * (leaving every shared copy where every Oxy app reads it) or after adopting
 * organization pairs nothing vouched for. So a `v: 1` record is not complete:
 * the run that meets it sweeps the shared group as an unproven device would
 * (every valid key and phrase quarantined, read back, then deleted there) and
 * marks every organization pair this device holds for re-validation against
 * the key the organization publishes ({@link pendingOrganizationRevalidation};
 * Commons runs it at launch, `revalidateHeldOrganizationKeys`). Only then is
 * the record rewritten as `v: 2`.
 */
const COMPLETION_KEY = 'oxy_keychain_group_migration_v1';
const COMPLETION_SERVICE = 'oxy_keychain_group_migration';
const SWEEP_VERSION = 2;

interface CompletionRecord {
  v: 1 | typeof SWEEP_VERSION;
  completedAt: number;
  /** The personal public key that sat in the shared group, when one did. */
  exposedPublicKey?: string;
  /** Organization account ids whose key sat in the shared group. */
  exposedOrganizations?: string[];
  /**
   * v2: organizations whose held pair a `v: 1` run may have adopted without
   * provenance, still to be checked against the organization's published key.
   */
  revalidate?: string[];
}

function parseRecord(raw: string | null): CompletionRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompletionRecord>;
    if (
      !parsed ||
      (parsed.v !== 1 && parsed.v !== SWEEP_VERSION) ||
      typeof parsed.completedAt !== 'number'
    ) {
      return null;
    }
    const record = parsed as CompletionRecord;
    if (
      record.revalidate !== undefined &&
      !(Array.isArray(record.revalidate) && record.revalidate.every((id) => typeof id === 'string'))
    ) {
      return { ...record, revalidate: [] };
    }
    return record;
  } catch {
    return null;
  }
}

/** What the wallet group's mirror says: only that Commons settled a run. */
const mirrorOf = (record: CompletionRecord) =>
  JSON.stringify({ v: record.v, completedAt: record.completedAt });

/** One stored value, and the group it belongs in. `deviceOnly` for secrets. */
interface Slot {
  key: string;
  service?: string;
  group: KeychainAccessGroupName;
  deviceOnly: boolean;
}

const slot = (
  key: string,
  item: Exclude<KeychainItemClass, 'app'>,
  service?: string,
  deviceOnly = true,
): Slot => ({
  key,
  service,
  group: keychainGroupFor(item),
  deviceOnly,
});

function publicKeyOf(privateKey: string | null): string | null {
  if (!privateKey || !isValidSecp256k1PrivateKey(privateKey)) return null;
  try {
    return deriveSecp256k1PublicKey(normalizeSecp256k1PrivateKey(privateKey));
  } catch {
    return null;
  }
}

function canonicalPublic(publicKey: string): string | null {
  try {
    return normalizeSecp256k1PublicKey(publicKey.trim());
  } catch {
    return null;
  }
}

/** The pair a phrase derives (`seed[0:32]`), or `null` for anything that is not a phrase. */
async function pairOfPhrase(
  phrase: string,
): Promise<{ privateKey: string; publicKey: string } | null> {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(normalized, wordlist)) return null;
  const seed = await mnemonicToSeed(normalized);
  const privateKey = Array.from(seed.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  const publicKey = publicKeyOf(privateKey);
  return publicKey ? { privateKey, publicKey } : null;
}

class Deferred extends Error {}

/**
 * Which ring a retired copy goes to: the person's (always quarantined here: no
 * owner is known), or an organization's, quarantined unless its provenance is
 * known.
 */
type Ring = { accountId?: string; quarantine?: boolean };

const nameOf = (s: Slot): KeychainItemName =>
  s.service === undefined ? { key: s.key } : { key: s.key, service: s.service };

class Mover {
  /** Proven items that were to be ADOPTED and could not move: Commons may still read their shared copy. */
  readonly adoptFailures: KeychainItemName[] = [];

  constructor(
    private readonly store: ExpoSecureStoreLike,
    private readonly access: KeychainAccess,
  ) {}

  private options(s: Slot, group: KeychainAccessGroupName, write = false): object {
    return {
      ...(s.service ? { keychainService: s.service } : {}),
      accessGroup: keychainAccessGroupValue(this.access, group),
      ...(write && s.deviceOnly
        ? { keychainAccessible: this.store.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
        : {}),
    };
  }

  /**
   * A read that throws means the keychain is unavailable: the whole run
   * defers. The shared group is read without user interaction (R5-9).
   */
  async read(s: Slot, group: KeychainAccessGroupName): Promise<string | null> {
    try {
      if (group === 'shared') {
        return await readSharedWithoutInteraction(
          this.store,
          s.key,
          s.service ? { keychainService: s.service } : {},
          { accessGroup: keychainAccessGroupValue(this.access, 'shared') },
        );
      }
      return (await this.store.getItemAsync(s.key, this.options(s, group))) ?? null;
    } catch (error) {
      throw new Deferred(error instanceof Error ? error.message : 'keychain read threw');
    }
  }

  /** Write `value` to the slot's group and read it back; `true` only when it holds exactly `value`. */
  async write(s: Slot, value: string): Promise<boolean> {
    try {
      await this.store.setItemAsync(s.key, value, this.options(s, s.group, true));
      return (await this.store.getItemAsync(s.key, this.options(s, s.group))) === value;
    } catch {
      return false;
    }
  }

  /**
   * Write `value` where the slot's group had nothing, then read it back. A
   * copy that reads back as something else is removed again (best effort):
   * reads look in the slot's group first and must not find it there.
   */
  async copy(s: Slot, value: string): Promise<boolean> {
    if (await this.write(s, value)) return true;
    try {
      await this.store.deleteItemAsync(s.key, this.options(s, s.group));
    } catch {
      // The shared copy is intact; the next run tries again.
    }
    return false;
  }

  async deleteShared(slots: Slot[]): Promise<boolean> {
    try {
      for (const s of slots) await this.store.deleteItemAsync(s.key, this.options(s, 'shared'));
      return true;
    } catch {
      return false;
    }
  }

  /** Keep a valid private key in a ring, then delete the shared copies. */
  async retireThenDelete(
    privateKey: string,
    ring: Ring,
    shared: Slot[],
  ): Promise<KeychainItemMigrationOutcome> {
    const publicKey = publicKeyOf(privateKey);
    if (!publicKey) return (await this.deleteShared(shared)) ? 'discarded' : 'failed';
    try {
      // Resolves only once the ring read it back.
      await retireIdentityKeyDuringMigration(
        { privateKey, publicKey },
        ring.accountId === undefined ? {} : { accountId: ring.accountId },
        { quarantine: ring.quarantine === true },
      );
    } catch (error) {
      // The quarantine is full (R6-14): the shared copy stays, never lost.
      return error instanceof RetiredKeyQuarantineFullError ? 'over-limit' : 'failed';
    }
    return (await this.deleteShared(shared)) ? 'retired' : 'failed';
  }

  /**
   * A personal or organization pair. `keep` decides, from the shared private
   * key, whether it is the key to adopt (`true`) or one to retire (`false`).
   * A half whose own group IS the shared group (the shared slot's public key)
   * is never moved or deleted here.
   */
  async movePair(
    privateSlot: Slot,
    publicSlot: Slot,
    keep: (publicKey: string) => boolean,
    ring: Ring,
  ): Promise<KeychainItemMigrationOutcome> {
    const movable = [privateSlot, publicSlot].filter((h) => h.group !== 'shared');
    const sharedPrivate = await this.read(privateSlot, 'shared');
    const sharedPublic =
      publicSlot.group === 'shared' ? null : await this.read(publicSlot, 'shared');
    if (sharedPrivate === null && sharedPublic === null) return 'absent';
    const derived = publicKeyOf(sharedPrivate);
    if (!sharedPrivate || !derived) {
      // A public half alone, or a private half that is not a key: nothing to keep.
      return (await this.deleteShared(movable)) ? 'discarded' : 'failed';
    }
    const targetPrivate = await this.read(privateSlot, privateSlot.group);
    if (!keep(derived) || (targetPrivate !== null && targetPrivate !== sharedPrivate)) {
      return this.retireThenDelete(sharedPrivate, ring, movable);
    }
    // Adopt (or finish adopting, after a run that died half-way): the private
    // key, and (when its group is not shared) the public key it derives —
    // never a stored public half that disagrees with it.
    const outcome = await this.adoptPair(
      privateSlot,
      publicSlot,
      sharedPrivate,
      derived,
      targetPrivate,
    );
    if (outcome === 'failed') this.adoptFailures.push(...movable.map(nameOf));
    return outcome;
  }

  private async adoptPair(
    privateSlot: Slot,
    publicSlot: Slot,
    sharedPrivate: string,
    derived: string,
    targetPrivate: string | null,
  ): Promise<KeychainItemMigrationOutcome> {
    if (targetPrivate === null && !(await this.copy(privateSlot, sharedPrivate))) return 'failed';
    if (publicSlot.group !== 'shared') {
      const targetPublic = await this.read(publicSlot, publicSlot.group);
      if (targetPublic === null || canonicalPublic(targetPublic) !== derived) {
        if (!(await this.write(publicSlot, derived))) return 'failed';
      }
    }
    if (publicKeyOf(await this.read(privateSlot, privateSlot.group)) !== derived) return 'failed';
    const movable = [privateSlot, publicSlot].filter((h) => h.group !== 'shared');
    return (await this.deleteShared(movable)) ? 'moved' : 'failed';
  }

  /** A phrase: adopted when it derives the key being kept, retired otherwise. */
  async movePhrase(
    s: Slot,
    keep: (publicKey: string) => boolean,
    ring: Ring,
  ): Promise<KeychainItemMigrationOutcome> {
    const shared = await this.read(s, 'shared');
    if (shared === null) return 'absent';
    const pair = await pairOfPhrase(shared);
    if (!pair) return (await this.deleteShared([s])) ? 'discarded' : 'failed';
    const target = await this.read(s, s.group);
    if (!keep(pair.publicKey) || (target !== null && target !== shared)) {
      return this.retireThenDelete(pair.privateKey, ring, [s]);
    }
    const adopted =
      (target !== null || (await this.copy(s, shared))) && (await this.deleteShared([s]));
    if (!adopted) this.adoptFailures.push(nameOf(s));
    return adopted ? 'moved' : 'failed';
  }

  /** A non-secret value (a timestamp): copied when the group has none. */
  async moveValue(s: Slot): Promise<KeychainItemMigrationOutcome> {
    const shared = await this.read(s, 'shared');
    if (shared === null) return 'absent';
    const target = await this.read(s, s.group);
    const moved =
      (target !== null || (await this.copy(s, shared))) && (await this.deleteShared([s]));
    if (!moved) this.adoptFailures.push(nameOf(s));
    return moved ? 'moved' : 'failed';
  }
}

const personalPairs = () => {
  const v2 = (key: string, service: string, deviceOnly: boolean) =>
    slot(key, 'identity-secret', service, deviceOnly);
  const legacy = (key: string, deviceOnly: boolean) =>
    slot(key, 'identity-secret', undefined, deviceOnly);
  return [
    {
      label: 'primary',
      privateSlot: v2(V2_STORAGE_KEYS.PRIVATE_KEY, V2_PRIMARY_KEYCHAIN_SERVICE, true),
      publicSlot: v2(V2_STORAGE_KEYS.PUBLIC_KEY, V2_PRIMARY_KEYCHAIN_SERVICE, false),
    },
    {
      label: 'backup',
      privateSlot: v2(V2_STORAGE_KEYS.BACKUP_PRIVATE_KEY, V2_BACKUP_KEYCHAIN_SERVICE, true),
      publicSlot: v2(V2_STORAGE_KEYS.BACKUP_PUBLIC_KEY, V2_BACKUP_KEYCHAIN_SERVICE, false),
    },
    {
      label: 'legacy-primary',
      privateSlot: legacy(STORAGE_KEYS.PRIVATE_KEY, true),
      publicSlot: legacy(STORAGE_KEYS.PUBLIC_KEY, false),
    },
    {
      label: 'legacy-backup',
      privateSlot: legacy(STORAGE_KEYS.BACKUP_PRIVATE_KEY, true),
      publicSlot: legacy(STORAGE_KEYS.BACKUP_PUBLIC_KEY, false),
    },
    {
      // The private key moves to the wallet group; its public key stays shared.
      label: 'shared-slot',
      privateSlot: slot(STORAGE_KEYS.SHARED_PRIVATE_KEY, 'spending-key'),
      publicSlot: slot(STORAGE_KEYS.SHARED_PUBLIC_KEY, 'shared', undefined, false),
    },
  ];
};

const TIMESTAMPS = [
  {
    label: 'backup-timestamp',
    slot: slot(
      V2_STORAGE_KEYS.BACKUP_TIMESTAMP,
      'identity-secret',
      V2_BACKUP_KEYCHAIN_SERVICE,
      false,
    ),
  },
  {
    label: 'legacy-backup-timestamp',
    slot: slot(STORAGE_KEYS.BACKUP_TIMESTAMP, 'identity-secret', undefined, false),
  },
];

const PHRASE_SLOT = slot(
  RECOVERY_MNEMONIC_STORAGE_KEY,
  'identity-secret',
  RECOVERY_MNEMONIC_KEYCHAIN_SERVICE,
);

const INDEX_SLOT = slot(
  ORGANIZATION_INDEX_STORAGE_KEY,
  'identity-secret',
  ORGANIZATION_INDEX_KEYCHAIN_SERVICE,
  false,
);

const RECORD_SLOT = slot(COMPLETION_KEY, 'identity-secret', COMPLETION_SERVICE, false);
const MIRROR_SLOT = slot(COMPLETION_KEY, 'spending-key', COMPLETION_SERVICE, false);

const ADOPTED = (o: KeychainItemMigrationOutcome) => o === 'moved';

/** The slots of one organization's pair and phrase. */
function organizationSlots(accountId: string) {
  return {
    privateSlot: slot(organizationPrivateKeyName(accountId), 'spending-key'),
    publicSlot: slot(organizationPublicKeyName(accountId), 'spending-key', undefined, false),
    phraseSlot: slot(
      organizationMnemonicName(accountId),
      'identity-secret',
      ORGANIZATION_MNEMONIC_KEYCHAIN_SERVICE,
    ),
  };
}

/**
 * How many organizations one run looks at (R6-14). The shared copy of the
 * index is writable by every Oxy app, so it can name any number of accounts,
 * and each costs several keychain reads; a real phone holds a few. The
 * organizations this device's OWN index names come first and are always
 * looked at; the shared copy fills the rest of the bound, sorted.
 */
export const MAX_MIGRATION_ORGANIZATIONS = 100;

/** Every organization either copy of the index names (read only to find items; never adopted from), bounded. */
async function namedOrganizations(mover: Mover): Promise<string[]> {
  const own = [...new Set(parseOrganizationIndex(await mover.read(INDEX_SLOT, INDEX_SLOT.group)))];
  const shared = [...new Set(parseOrganizationIndex(await mover.read(INDEX_SLOT, 'shared')))]
    .filter((id) => !own.includes(id))
    .sort();
  const room = Math.max(0, MAX_MIGRATION_ORGANIZATIONS - own.length);
  return [...own, ...shared.slice(0, room)].sort();
}

/** The proven run: everything the marker vouches for; organizations only when this device already holds them. */
async function migrateProven(
  mover: Mover,
  owner: string,
  items: Record<string, KeychainItemMigrationOutcome>,
): Promise<{ personalExposed: boolean; organizations: string[] }> {
  const isOwner = (publicKey: string) => publicKey === owner;
  let personalExposed = false;
  for (const pair of personalPairs()) {
    items[pair.label] = await mover.movePair(pair.privateSlot, pair.publicSlot, isOwner, {});
    personalExposed ||= ADOPTED(items[pair.label]);
  }
  for (const t of TIMESTAMPS) items[t.label] = await mover.moveValue(t.slot);
  items.phrase = await mover.movePhrase(PHRASE_SLOT, isOwner, {});
  personalExposed ||= ADOPTED(items.phrase);

  // Organizations (R5-7): the marker vouches for the person only. An
  // organization's shared copy is adopted only when it IS the key this device
  // already keeps for it in the wallet group (a run that died half-way, or a
  // copy Commons wrote twice); anything else is kept quarantined in that
  // organization's ring until its own key history names it.
  const organizations: string[] = [];
  const held: string[] = [];
  let n = 0;
  for (const accountId of await namedOrganizations(mover)) {
    n += 1;
    const ring = { accountId, quarantine: true };
    const { privateSlot, publicSlot, phraseSlot } = organizationSlots(accountId);
    const kept = publicKeyOf(await mover.read(privateSlot, privateSlot.group));
    const isKept = (publicKey: string) => kept !== null && publicKey === kept;
    items[`organization-${n}`] = await mover.movePair(privateSlot, publicSlot, isKept, ring);
    items[`organization-${n}-phrase`] = await mover.movePhrase(phraseSlot, isKept, ring);
    const outcome = items[`organization-${n}`];
    if (outcome === 'moved' || outcome === 'retired') organizations.push(accountId);
    if (kept !== null) held.push(accountId);
  }
  // The index last: the organizations this device KEEPS a pair for, never one
  // the shared copy alone names. The shared copy is how a later run finds the
  // organizations' shared items, so it stays while any of them is left.
  const orgLeft = Object.entries(items).some(
    ([label, outcome]) => label.startsWith('organization-') && outcome === 'failed',
  );
  items['organization-index'] = await moveIndex(mover, held, !orgLeft);
  return { personalExposed, organizations };
}

/**
 * The identity group's index gains the organizations this device holds a pair
 * for; the shared copy is then deleted (it is not adopted). Strict: an own
 * index that cannot be read is never overwritten (`failed`).
 */
async function moveIndex(
  mover: Mover,
  held: string[],
  deleteShared: boolean,
): Promise<KeychainItemMigrationOutcome> {
  const shared = await mover.read(INDEX_SLOT, 'shared');
  const target = await mover.read(INDEX_SLOT, INDEX_SLOT.group);
  let own: string[];
  try {
    own = parseOrganizationIndexStrict(target);
  } catch {
    return 'failed';
  }
  const grows = held.some((id) => !own.includes(id));
  if (grows) {
    const next = serializeOrganizationIndex([...own, ...held]);
    if (
      !(target === null ? await mover.copy(INDEX_SLOT, next) : await mover.write(INDEX_SLOT, next))
    )
      return 'failed';
  }
  if (shared === null) return grows ? 'moved' : 'absent';
  if (!deleteShared) return 'failed';
  return (await mover.deleteShared([INDEX_SLOT])) ? 'moved' : 'failed';
}

/**
 * The unproven run (R5-3): no marker vouches for anything in the shared group,
 * so nothing is adopted — but nothing that could be money is destroyed or left
 * where every app can read it either. Every valid key and phrase there (the
 * personal slots, the shared slot, the personal phrase, the pairs and phrases
 * of every organization either index names) is kept QUARANTINED in its ring,
 * read back, and only then deleted. Non-secrets (timestamps, the index) stay.
 */
async function migrateUnproven(
  mover: Mover,
  items: Record<string, KeychainItemMigrationOutcome>,
): Promise<void> {
  const never = () => false;
  for (const pair of personalPairs()) {
    items[pair.label] = await mover.movePair(pair.privateSlot, pair.publicSlot, never, {});
  }
  items.phrase = await mover.movePhrase(PHRASE_SLOT, never, {});
  let n = 0;
  for (const accountId of await namedOrganizations(mover)) {
    n += 1;
    const ring = { accountId, quarantine: true };
    const { privateSlot, publicSlot, phraseSlot } = organizationSlots(accountId);
    items[`organization-${n}`] = await mover.movePair(privateSlot, publicSlot, never, ring);
    items[`organization-${n}-phrase`] = await mover.movePhrase(phraseSlot, never, ring);
  }
}

/** Write the completion record and its mirror; `true` once both read back. */
async function writeRecord(mover: Mover, record: CompletionRecord): Promise<boolean> {
  return (
    (await mover.write(RECORD_SLOT, JSON.stringify(record))) &&
    (await mover.write(MIRROR_SLOT, mirrorOf(record)))
  );
}

/**
 * The organizations this device holds a pair for, from its own index (the
 * identity group), for re-validation after a `v: 1` record. Strict: `null`
 * for an index that cannot be read as one (the run is then `incomplete` and
 * retried, never settled without them). A thrown keychain read defers.
 */
async function heldOrganizations(mover: Mover): Promise<string[] | null> {
  const raw = await mover.read(INDEX_SLOT, INDEX_SLOT.group);
  try {
    return parseOrganizationIndexStrict(raw);
  } catch {
    return null;
  }
}

/** Run the migration once. Exported for tests; production code awaits the gate. */
export async function runKeychainGroupMigration(): Promise<KeychainGroupMigrationReport> {
  let access: KeychainAccess;
  try {
    access = await resolveKeychainAccess();
  } catch {
    return { state: 'deferred', items: {} };
  }
  if (access.mode !== 'grouped' || access.role !== 'holder') {
    return { state: 'not-applicable', items: {} };
  }
  let store: ExpoSecureStoreLike;
  try {
    store = await loadSecureStore();
  } catch {
    return { state: 'deferred', items: {} };
  }
  const mover = new Mover(store, access);
  const items: Record<string, KeychainItemMigrationOutcome> = {};
  setHolderSharedSecretFallback([]);
  if (access.variant) {
    // A development build (R5-5): the shared group has no dev variant, so what
    // is there is production's. Never read, moved or deleted; only the record
    // is written (best effort), so the dev wallet stops asking.
    try {
      const existing = parseRecord(await mover.read(RECORD_SLOT, RECORD_SLOT.group));
      if (existing === null || existing.v !== SWEEP_VERSION) {
        await writeRecord(mover, { v: SWEEP_VERSION, completedAt: Date.now() });
      }
    } catch {
      // Locked: nothing depends on the record in a dev build.
    }
    return { state: 'not-applicable', items };
  }
  let record: CompletionRecord;
  let proven = false;
  try {
    const existing = parseRecord(await mover.read(RECORD_SLOT, RECORD_SLOT.group));
    if (existing?.v === SWEEP_VERSION) {
      // Done before. Re-mirror (the wallet group may have been cleared).
      if ((await mover.read(MIRROR_SLOT, MIRROR_SLOT.group)) === null) {
        await mover.write(MIRROR_SLOT, mirrorOf(existing));
      }
      return { state: 'complete', items };
    }
    if (existing) {
      // A `v: 1` record (R6-3): whatever wrote it may have left copies in the
      // shared group or adopted organization pairs nothing vouched for. Sweep
      // as an unproven device does, then hand every held organization pair to
      // the launch-time re-validation. The `v: 1` record stays until the sweep
      // settled, so a failure here never reopens a fallback.
      const held = await heldOrganizations(mover);
      if (held === null) items['organization-index'] = 'failed';
      const revalidate = [...new Set([...(existing.revalidate ?? []), ...(held ?? [])])].sort();
      await migrateUnproven(mover, items);
      record = {
        ...existing,
        v: SWEEP_VERSION,
        ...(revalidate.length > 0 ? { revalidate } : {}),
      };
      return await settle(mover, items, record, false);
    }
    let marker: Awaited<ReturnType<typeof readIdentityMarkerStrict>>;
    try {
      marker = await readIdentityMarkerStrict();
    } catch (error) {
      throw new Deferred(error instanceof Error ? error.message : 'marker unreadable');
    }
    const owner = marker ? canonicalPublic(marker.publicKey) : null;
    record = { v: SWEEP_VERSION, completedAt: Date.now() };
    if (owner) {
      proven = true;
      const exposure = await migrateProven(mover, owner, items);
      if (exposure.personalExposed) record.exposedPublicKey = owner;
      if (exposure.organizations.length > 0) record.exposedOrganizations = exposure.organizations;
    } else {
      // No marker: this Commons cannot prove it wrote anything in the shared
      // group. Nothing there is adopted, now or later; every key and phrase is
      // kept quarantined before it is deleted.
      await migrateUnproven(mover, items);
    }
  } catch (error) {
    if (error instanceof Deferred) {
      return { state: 'deferred', items, proven };
    }
    throw error;
  }
  return settle(mover, items, record, proven);
}

/** Settle a run: `incomplete` while any unit failed, else the record is written. */
async function settle(
  mover: Mover,
  items: Record<string, KeychainItemMigrationOutcome>,
  record: CompletionRecord,
  proven: boolean,
): Promise<KeychainGroupMigrationReport> {
  const failed = Object.entries(items).filter(([, o]) => o === 'failed');
  const overLimit = Object.entries(items).filter(([, o]) => o === 'over-limit');
  if (overLimit.length > 0) {
    logger.warn('Keychain access-group migration left keys in the shared group: quarantine full', {
      component: 'KeychainGroupMigration',
      items: overLimit.map(([label]) => label).join(','),
    });
  }
  if (failed.length > 0) {
    // The proven items that could not move are still in the shared group:
    // Commons may read exactly those there until a retry moves them (R5-9).
    // Nothing unproven, nothing being retired and no index ever opens.
    setHolderSharedSecretFallback(proven ? mover.adoptFailures : []);
    logger.warn('Keychain access-group migration left items in the shared group', {
      component: 'KeychainGroupMigration',
      items: failed.map(([label]) => label).join(','),
    });
    return { state: 'incomplete', items, proven };
  }
  if (!(await writeRecord(mover, record))) {
    return { state: 'incomplete', items, proven };
  }
  return { state: 'complete', items, proven };
}

/**
 * A Commons secret write found a DIFFERENT copy of the same item in the shared
 * group (R5-3): keep it before that copy is deleted. A valid private key or
 * phrase under one of the names Commons kept secrets under before the split
 * goes to its ring QUARANTINED (an organization's for its pair and phrase, the
 * person's otherwise) and is read back; any other value is not a secret and is
 * left to the delete. Throws when it cannot be kept, which fails the write.
 */
async function keepSharedCopy(name: KeychainItemName, value: string): Promise<boolean> {
  const accountId = organizationOfSecretItem(name.key);
  if (accountId === null && !PERSONAL_SECRET_NAMES.has(`${name.service ?? 'app'}|${name.key}`)) {
    return true;
  }
  const privateKey = publicKeyOf(value) ? normalizeSecp256k1PrivateKey(value) : null;
  const pair = privateKey
    ? { privateKey, publicKey: publicKeyOf(privateKey) as string }
    : await pairOfPhrase(value);
  if (!pair) return true;
  try {
    await retireIdentityKeyDuringMigration(pair, accountId === null ? {} : { accountId }, {
      quarantine: true,
    });
  } catch (error) {
    // Full (R6-14): leave the shared copy, never lose it.
    if (error instanceof RetiredKeyQuarantineFullError) return false;
    throw error;
  }
  return true;
}

/** The personal secret items Commons kept in the shared group before the split. */
const PERSONAL_SECRET_NAMES = new Set(
  [...personalPairs().map((pair) => pair.privateSlot), PHRASE_SLOT].map(
    (s) => `${s.service ?? 'app'}|${s.key}`,
  ),
);

setSharedCopyKeeper(keepSharedCopy);

/**
 * What every keychain-backed identity access awaits first, by role: Commons
 * runs (or has run) the migration; the Peable wallet checks once whether
 * Commons' completion record is in the wallet group, and from then on never
 * falls back to the shared group for a secret. Never throws.
 */
export async function prepareKeychainAccess(access: KeychainAccess): Promise<void> {
  if (access.mode !== 'grouped') return;
  if (access.role === 'holder') {
    await ensureKeychainGroupsMigrated();
    return;
  }
  if (access.role === 'wallet' && !walletSawCompletion) {
    try {
      const store = await loadSecureStore();
      const mirror = await store.getItemAsync(COMPLETION_KEY, {
        keychainService: COMPLETION_SERVICE,
        accessGroup: keychainAccessGroupValue(access, 'wallet'),
      });
      if (parseRecord(mirror)) {
        walletSawCompletion = true;
        closeWalletSharedSecretFallback();
      }
    } catch {
      // Locked: the next access asks again.
    }
  }
}

let walletSawCompletion = false;

/**
 * Commons, iOS: the organizations whose held pair still waits for
 * re-validation after a `v: 1` completion record (R6-3), from the v2 record.
 * Empty elsewhere, before the run settled, or when there is nothing to check.
 * @internal — `revalidateHeldOrganizationKeys` (organization keys) reads it.
 */
export async function pendingOrganizationRevalidation(): Promise<string[]> {
  const context = await holderRecordContext();
  return context?.record.revalidate ?? [];
}

/**
 * Drop `accountId` from the pending re-validation list, once it was checked.
 * Resolves whether the record was rewritten (or had nothing to drop). @internal
 */
export async function settleOrganizationRevalidation(accountId: string): Promise<boolean> {
  const context = await holderRecordContext();
  if (!context?.record.revalidate?.includes(accountId)) return true;
  const revalidate = context.record.revalidate.filter((id) => id !== accountId);
  const { revalidate: _done, ...rest } = context.record;
  const next: CompletionRecord = revalidate.length > 0 ? { ...rest, revalidate } : rest;
  return context.mover.write(RECORD_SLOT, JSON.stringify(next));
}

/** Commons' settled v2 record, with the mover to rewrite it; `null` elsewhere. */
async function holderRecordContext(): Promise<{ mover: Mover; record: CompletionRecord } | null> {
  const access = await resolveKeychainAccess();
  if (access.mode !== 'grouped' || access.role !== 'holder' || access.variant) return null;
  await ensureKeychainGroupsMigrated();
  const mover = new Mover(await loadSecureStore(), access);
  const record = parseRecord(await mover.read(RECORD_SLOT, RECORD_SLOT.group));
  return record?.v === SWEEP_VERSION ? { mover, record } : null;
}

/**
 * Commons: whether this device's identity keys sat in the shared keychain
 * group before the split, where every Oxy iOS app could read them. `publicKey`
 * is the personal key that was exposed (recommend a rotation while it is still
 * the current key), `organizations` the organization accounts whose key was.
 * `null` when nothing was exposed, the migration has not finished, or this is
 * not Commons on iOS.
 */
export async function getPreSplitExposure(): Promise<{
  publicKey: string | null;
  organizations: string[];
} | null> {
  try {
    const access = await resolveKeychainAccess();
    if (access.mode !== 'grouped' || access.role !== 'holder') return null;
    await ensureKeychainGroupsMigrated();
    const store = await loadSecureStore();
    const record = parseRecord(
      await store.getItemAsync(COMPLETION_KEY, {
        keychainService: COMPLETION_SERVICE,
        accessGroup: keychainAccessGroupValue(access, 'identity'),
      }),
    );
    if (!record || (!record.exposedPublicKey && !record.exposedOrganizations?.length)) return null;
    return {
      publicKey: record.exposedPublicKey ?? null,
      organizations: record.exposedOrganizations ?? [],
    };
  } catch {
    return null;
  }
}

let settledReport: KeychainGroupMigrationReport | null = null;
let inFlight: Promise<KeychainGroupMigrationReport> | null = null;
/** An `incomplete` run's retries in this process (R5-9): when the next may start, and how many ran. */
let retryAt = 0;
let retries = 0;

/** First retry after 30 s, doubling; at most {@link MAX_INCOMPLETE_RETRIES} per process. */
const RETRY_BASE_MS = 30_000;
const MAX_INCOMPLETE_RETRIES = 5;

/**
 * The gate every Commons identity-storage access awaits. `complete` and
 * `not-applicable` are kept for the process. An `incomplete` run is retried on
 * a later access once its backoff has passed (30 s, doubling, at most five
 * times per process; R5-9) and again on the next launch; until then the
 * report stands and only the proven items that could not move fall back to
 * the shared group. A `deferred` run is forgotten, so the next access tries
 * again once the keychain unlocks. Concurrent callers share one run. Never
 * throws.
 */
export function ensureKeychainGroupsMigrated(): Promise<KeychainGroupMigrationReport> {
  if (
    settledReport &&
    !(
      settledReport.state === 'incomplete' &&
      retries < MAX_INCOMPLETE_RETRIES &&
      Date.now() >= retryAt
    )
  ) {
    return Promise.resolve(settledReport);
  }
  if (!inFlight) {
    const retrying = settledReport?.state === 'incomplete';
    if (retrying) retries += 1;
    inFlight = runKeychainGroupMigration()
      .catch((error: unknown): KeychainGroupMigrationReport => {
        logger.warn(
          'Keychain access-group migration threw; retrying on the next access',
          { component: 'KeychainGroupMigration' },
          error,
        );
        return { state: 'deferred', items: {} };
      })
      .then((report) => {
        if (report.state === 'incomplete') {
          retryAt = Date.now() + RETRY_BASE_MS * 2 ** retries;
          settledReport = report;
        } else if (report.state !== 'deferred') {
          settledReport = report;
        }
        inFlight = null;
        return report;
      });
  }
  return inFlight;
}

/** Forget the memoized run. Tests only. @internal */
export function resetKeychainGroupMigrationForTests(): void {
  settledReport = null;
  inFlight = null;
  walletSawCompletion = false;
  retryAt = 0;
  retries = 0;
}
