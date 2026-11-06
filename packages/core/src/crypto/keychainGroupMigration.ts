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
 *   records; a phrase only when it derives it. Organization items are adopted
 *   only on such a proven device (before the split every Oxy app could already
 *   read and replace them, so a proven upgrade gains nothing by doubting them).
 *   No marker — a fresh install, a reinstall, a device that never ran a
 *   marker-aware Commons — adopts NOTHING from the shared group, ever.
 * - **One shot.** When a run settles, a completion record is written to the
 *   identity group (Commons only) and mirrored into the wallet group (for the
 *   Peable wallet). With it, no later run looks at the shared group and no
 *   read falls back to it (`setHolderSharedSecretFallback`,
 *   `closeWalletSharedSecretFallback`).
 * - **A different key is retired, then deleted (R4-6).** On a proven device a
 *   shared copy that is a valid key but not the one being kept (a replaced
 *   root, an old backup slot, an organization's previous key, a phrase of
 *   either) is kept in the retired ring (`./retiredKeys`, spending only), read
 *   back, and only then deleted from the shared group. Nothing that could
 *   hold money is destroyed, and nothing stays where every app can read it.
 *
 * Each adopted item moves by VERIFY-BEFORE-DELETE: read it from the shared
 * group, write it to its group, read it back (a pair must be healthy, a value
 * byte-identical), and only then delete the shared copy. A failure at any step
 * leaves the shared copy; the run is `incomplete`, no record is written, and
 * on a proven device Commons' reads may still fall back to the shared group
 * for that launch; the next launch resumes.
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
  closeWalletSharedSecretFallback,
  keychainAccessGroupValue,
  keychainGroupFor,
  resolveKeychainAccess,
  setHolderSharedSecretFallback,
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
  organizationPrivateKeyName,
  organizationPublicKeyName,
  parseOrganizationIndex,
  serializeOrganizationIndex,
} from './keychainItems';
import { retireIdentityKeyDuringMigration } from './retiredKeys';

/** What happened to one item (or pair) in a run. */
export type KeychainItemMigrationOutcome =
  | 'absent'
  | 'moved'
  | 'retired'
  | 'discarded'
  | 'failed'
  | 'deferred';

export interface KeychainGroupMigrationReport {
  /**
   * - `not-applicable`: not Commons on a split-aware iOS build; nothing to move.
   * - `complete`: the completion record exists; the shared group is never
   *   read again for a secret.
   * - `incomplete`: a copy or delete failed; retried next launch.
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
 */
const COMPLETION_KEY = 'oxy_keychain_group_migration_v1';
const COMPLETION_SERVICE = 'oxy_keychain_group_migration';

interface CompletionRecord {
  v: 1;
  completedAt: number;
  /** The personal public key that sat in the shared group, when one did. */
  exposedPublicKey?: string;
  /** Organization account ids whose key sat in the shared group. */
  exposedOrganizations?: string[];
}

function parseRecord(raw: string | null): CompletionRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompletionRecord>;
    return parsed && parsed.v === 1 && typeof parsed.completedAt === 'number'
      ? (parsed as CompletionRecord)
      : null;
  } catch {
    return null;
  }
}

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

/** Which ring a retired copy goes to: the person's, or an organization's. */
type Ring = { accountId?: string };

class Mover {
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

  /** A read that throws means the keychain is unavailable: the whole run defers. */
  async read(s: Slot, group: KeychainAccessGroupName): Promise<string | null> {
    try {
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
      await retireIdentityKeyDuringMigration({ privateKey, publicKey }, ring);
    } catch {
      return 'failed';
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
    if (targetPrivate === null && !(await this.copy(privateSlot, sharedPrivate))) return 'failed';
    if (publicSlot.group !== 'shared') {
      const targetPublic = await this.read(publicSlot, publicSlot.group);
      if (targetPublic === null || canonicalPublic(targetPublic) !== derived) {
        if (!(await this.write(publicSlot, derived))) return 'failed';
      }
    }
    if (publicKeyOf(await this.read(privateSlot, privateSlot.group)) !== derived) return 'failed';
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
    if (target === null && !(await this.copy(s, shared))) return 'failed';
    return (await this.deleteShared([s])) ? 'moved' : 'failed';
  }

  /** A non-secret value (a timestamp, the index): copied when the group has none, merged by `merge`. */
  async moveValue(
    s: Slot,
    merge?: (shared: string, target: string) => string,
  ): Promise<KeychainItemMigrationOutcome> {
    const shared = await this.read(s, 'shared');
    if (shared === null) return 'absent';
    const target = await this.read(s, s.group);
    const keep = target === null ? shared : merge ? merge(shared, target) : target;
    if (keep !== target) {
      if (!(target === null ? await this.copy(s, keep) : await this.write(s, keep)))
        return 'failed';
    }
    return (await this.deleteShared([s])) ? 'moved' : 'failed';
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

/** Union of two indexes; never drops an id either side lists. */
function mergeIndexes(shared: string, target: string): string {
  return serializeOrganizationIndex([
    ...parseOrganizationIndex(shared),
    ...parseOrganizationIndex(target),
  ]);
}

const ADOPTED = (o: KeychainItemMigrationOutcome) => o === 'moved';

/** The proven run: everything the marker vouches for, every organization item. */
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

  // Organizations: every id either copy of the index names.
  const ids = new Set([
    ...parseOrganizationIndex(await mover.read(INDEX_SLOT, 'shared')),
    ...parseOrganizationIndex(await mover.read(INDEX_SLOT, INDEX_SLOT.group)),
  ]);
  const organizations: string[] = [];
  let n = 0;
  for (const accountId of [...ids].sort()) {
    n += 1;
    const ring = { accountId };
    const privateSlot = slot(organizationPrivateKeyName(accountId), 'spending-key');
    const publicSlot = slot(organizationPublicKeyName(accountId), 'spending-key', undefined, false);
    // The organization's key is whichever this device keeps after the move:
    // the wallet group's when it has one, else the shared copy.
    const kept =
      publicKeyOf(await mover.read(privateSlot, privateSlot.group)) ??
      publicKeyOf(await mover.read(privateSlot, 'shared'));
    const isKept = (publicKey: string) => publicKey === kept;
    items[`organization-${n}`] = await mover.movePair(privateSlot, publicSlot, isKept, ring);
    items[`organization-${n}-phrase`] = await mover.movePhrase(
      slot(
        organizationMnemonicName(accountId),
        'identity-secret',
        ORGANIZATION_MNEMONIC_KEYCHAIN_SERVICE,
      ),
      isKept,
      ring,
    );
    if (ADOPTED(items[`organization-${n}`])) organizations.push(accountId);
  }
  // The index last: it is how a later run finds the organizations above.
  items['organization-index'] = await mover.moveValue(INDEX_SLOT, mergeIndexes);
  return { personalExposed, organizations };
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
  setHolderSharedSecretFallback(false);
  let record: CompletionRecord;
  let proven = false;
  try {
    const existing = parseRecord(await mover.read(RECORD_SLOT, RECORD_SLOT.group));
    if (existing) {
      // Done before. Re-mirror (the wallet group may have been cleared).
      if ((await mover.read(MIRROR_SLOT, MIRROR_SLOT.group)) === null) {
        await mover.write(MIRROR_SLOT, JSON.stringify({ v: 1, completedAt: existing.completedAt }));
      }
      return { state: 'complete', items };
    }
    let marker: Awaited<ReturnType<typeof readIdentityMarkerStrict>>;
    try {
      marker = await readIdentityMarkerStrict();
    } catch (error) {
      throw new Deferred(error instanceof Error ? error.message : 'marker unreadable');
    }
    const owner = marker ? canonicalPublic(marker.publicKey) : null;
    record = { v: 1, completedAt: Date.now() };
    if (owner) {
      proven = true;
      const exposure = await migrateProven(mover, owner, items);
      if (exposure.personalExposed) record.exposedPublicKey = owner;
      if (exposure.organizations.length > 0) record.exposedOrganizations = exposure.organizations;
    }
    // No marker: this Commons wrote nothing that is in the shared group (or
    // cannot prove it did). Nothing there is adopted, now or later.
  } catch (error) {
    if (error instanceof Deferred) {
      return { state: 'deferred', items, proven };
    }
    throw error;
  }
  const failed = Object.entries(items).filter(([, o]) => o === 'failed');
  if (failed.length > 0) {
    // Proven copies are still in the shared group: let Commons read them for
    // this launch, and try again on the next one.
    setHolderSharedSecretFallback(true);
    logger.warn('Keychain access-group migration left items in the shared group', {
      component: 'KeychainGroupMigration',
      items: failed.map(([label]) => label).join(','),
    });
    return { state: 'incomplete', items, proven };
  }
  if (
    !(await mover.write(RECORD_SLOT, JSON.stringify(record))) ||
    !(await mover.write(MIRROR_SLOT, JSON.stringify({ v: 1, completedAt: record.completedAt })))
  ) {
    return { state: 'incomplete', items, proven };
  }
  return { state: 'complete', items, proven };
}

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

/**
 * The gate every Commons identity-storage access awaits. One run per process
 * (`complete`, `incomplete` and `not-applicable` are kept; `incomplete` is
 * retried on the next launch); a `deferred` run is forgotten, so the next
 * access tries again once the keychain unlocks. Concurrent callers share one
 * run. Never throws.
 */
export function ensureKeychainGroupsMigrated(): Promise<KeychainGroupMigrationReport> {
  if (settledReport) {
    return Promise.resolve(settledReport);
  }
  if (!inFlight) {
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
        if (report.state !== 'deferred') {
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
}
