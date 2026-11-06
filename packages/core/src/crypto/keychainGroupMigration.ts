/**
 * Commons, iOS: move every identity item out of the shared keychain group
 * into the group it belongs to (docs/identity/ios-keychain-access-groups.md
 * "Migrating existing items", ADR 0062).
 *
 * Before the split Commons listed one access group, the shared one, so every
 * item it wrote landed there — the root key, both phrases, organization keys.
 * Each item is moved by VERIFY-BEFORE-DELETE:
 *
 *   1. read it from the shared group (an explicit `accessGroup`);
 *   2. write it to its new group;
 *   3. read it back from there and check it: a pair must be healthy (the
 *      public key derives from the private one), any value byte-identical;
 *   4. only then delete it from the shared group.
 *
 * INVARIANT: at every instant each item has at least one readable copy, and a
 * copy is never overwritten with a different value. A failure at any step
 * leaves the shared copy where it is; the next run (the next accessor call
 * for a thrown read, the next launch otherwise) resumes from whatever state
 * the last one reached:
 *
 * - shared only            → copy, verify, delete;
 * - shared and new, equal  → (a crash after the copy) verify, delete;
 * - new only               → done;
 * - shared and new DIFFER  → `conflict`: both stay. The new group was written
 *   after the split, so it is current, but the shared copy may be a replaced
 *   key that still receives money, and no step here may destroy one.
 * - a pair that is not healthy → `unhealthy`: left in place, never moved.
 *
 * Every read the rest of the SDK makes goes through `keychainReadPlan` (its
 * group, then the shared group), so it finds an item wherever this run left it.
 * `ensureKeychainGroupsMigrated` is awaited by every KeyManager and
 * organization-key storage access in Commons, so no write of theirs can
 * interleave with a copy here (a copy racing a rotation could otherwise put
 * the replaced key back).
 *
 * Nothing is logged but item labels and outcomes; never a value.
 */
import {
  deriveSecp256k1PublicKey,
  normalizeSecp256k1PrivateKey,
  normalizeSecp256k1PublicKey,
} from '@oxy.so/protocol/secp256k1';
import { type ExpoSecureStoreLike, loadSecureStore } from '@oxy.so/protocol';
import { logger } from '../logger';
import {
  type KeychainAccess,
  type KeychainAccessGroupName,
  type KeychainItemClass,
  keychainAccessGroupValue,
  keychainGroupFor,
  resolveKeychainAccess,
} from '../utils/keychainAccessGroups';
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

/** What happened to one item (or pair) in a run. */
export type KeychainItemMigrationOutcome =
  | 'absent'
  | 'moved'
  | 'conflict'
  | 'unhealthy'
  | 'failed'
  | 'deferred';

export interface KeychainGroupMigrationReport {
  /**
   * - `not-applicable`: not Commons on a split-aware iOS build; nothing to move.
   * - `complete`: nothing secret is left in the shared group.
   * - `incomplete`: something stayed (`conflict`, `unhealthy` or `failed`);
   *   retried next launch.
   * - `deferred`: the keychain could not be read (locked); retried on the next
   *   storage access.
   */
  state: 'not-applicable' | 'complete' | 'incomplete' | 'deferred';
  /** Outcome per item label (`primary`, `phrase`, `organization-1`, …). */
  items: Record<string, KeychainItemMigrationOutcome>;
}

/** One stored value, and the group it belongs in. `deviceOnly` for secrets. */
interface Slot {
  key: string;
  service?: string;
  group: KeychainAccessGroupName;
  deviceOnly: boolean;
}

/** A unit moved together: a pair (health-checked) or a single value. */
type Unit =
  | { label: string; kind: 'pair'; privateSlot: Slot; publicSlot: Slot }
  | {
      label: string;
      kind: 'value';
      slot: Slot;
      /** When the two copies differ: the value to keep instead, or `null` (conflict). */
      merge?: (shared: string, target: string) => string | null;
    };

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

function isHealthyPair(privateKey: string | null, publicKey: string | null): boolean {
  if (!privateKey || !publicKey) return false;
  try {
    return (
      deriveSecp256k1PublicKey(normalizeSecp256k1PrivateKey(privateKey)) ===
      normalizeSecp256k1PublicKey(publicKey)
    );
  } catch {
    return false;
  }
}

class Deferred extends Error {}

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

  /**
   * Write `value` where the new group had nothing, then read it back; `true`
   * only when the new group holds exactly `value`. A copy that reads back as
   * something else is removed again (best effort), because reads look in the
   * new group FIRST and must not find it there.
   */
  async copy(s: Slot, value: string, replacing = false): Promise<boolean> {
    try {
      await this.store.setItemAsync(s.key, value, this.options(s, s.group, true));
      if ((await this.store.getItemAsync(s.key, this.options(s, s.group))) === value) {
        return true;
      }
    } catch {
      return false;
    }
    if (replacing) {
      // A merge overwrote what was there; keep whatever is there now.
      return false;
    }
    try {
      await this.store.deleteItemAsync(s.key, this.options(s, s.group));
    } catch {
      // The next run reads it as a conflict and leaves both; the shared copy is intact.
    }
    return false;
  }

  async deleteShared(s: Slot): Promise<boolean> {
    try {
      await this.store.deleteItemAsync(s.key, this.options(s, 'shared'));
      return true;
    } catch {
      return false;
    }
  }

  async moveValue(unit: Extract<Unit, { kind: 'value' }>): Promise<KeychainItemMigrationOutcome> {
    const { slot: s } = unit;
    const shared = await this.read(s, 'shared');
    if (shared === null) return 'absent';
    const target = await this.read(s, s.group);
    let keep = target ?? shared;
    if (target !== null && target !== shared) {
      const merged = unit.merge?.(shared, target) ?? null;
      if (merged === null) return 'conflict';
      keep = merged;
    }
    if (target !== keep && !(await this.copy(s, keep, target !== null))) return 'failed';
    // Verify the copy that is about to become the only one.
    if ((await this.read(s, s.group)) !== keep) return 'failed';
    return (await this.deleteShared(s)) ? 'moved' : 'failed';
  }

  async movePair(unit: Extract<Unit, { kind: 'pair' }>): Promise<KeychainItemMigrationOutcome> {
    const halves = [unit.privateSlot, unit.publicSlot];
    // A half whose group IS the shared group stays: it is read, never moved.
    const movable = halves.filter((h) => h.group !== 'shared');
    const shared = await Promise.all(halves.map((h) => this.read(h, 'shared')));
    if (movable.every((h) => shared[halves.indexOf(h)] === null)) return 'absent';
    const target = await Promise.all(
      halves.map((h, i) => (h.group === 'shared' ? shared[i] : this.read(h, h.group))),
    );
    for (const h of movable) {
      const i = halves.indexOf(h);
      if (shared[i] !== null && target[i] !== null && shared[i] !== target[i]) return 'conflict';
    }
    const finalPair = halves.map((_, i) => target[i] ?? shared[i]);
    if (!isHealthyPair(finalPair[0], finalPair[1])) return 'unhealthy';
    for (const h of movable) {
      const i = halves.indexOf(h);
      const value = shared[i];
      if (value !== null && target[i] === null && !(await this.copy(h, value))) return 'failed';
    }
    const readBack = await Promise.all(
      halves.map((h, i) => (h.group === 'shared' ? shared[i] : this.read(h, h.group))),
    );
    if (readBack.some((v, i) => v !== finalPair[i]) || !isHealthyPair(readBack[0], readBack[1])) {
      return 'failed';
    }
    for (const h of movable) {
      if (shared[halves.indexOf(h)] !== null && !(await this.deleteShared(h))) return 'failed';
    }
    return 'moved';
  }

  move(unit: Unit): Promise<KeychainItemMigrationOutcome> {
    return unit.kind === 'pair' ? this.movePair(unit) : this.moveValue(unit);
  }
}

/** The personal items, in the order they move. */
function personalUnits(): Unit[] {
  const v2 = (key: string, service: string, deviceOnly: boolean) =>
    slot(key, 'identity-secret', service, deviceOnly);
  const legacy = (key: string, deviceOnly: boolean) =>
    slot(key, 'identity-secret', undefined, deviceOnly);
  return [
    {
      label: 'primary',
      kind: 'pair',
      privateSlot: v2(V2_STORAGE_KEYS.PRIVATE_KEY, V2_PRIMARY_KEYCHAIN_SERVICE, true),
      publicSlot: v2(V2_STORAGE_KEYS.PUBLIC_KEY, V2_PRIMARY_KEYCHAIN_SERVICE, false),
    },
    {
      label: 'backup',
      kind: 'pair',
      privateSlot: v2(V2_STORAGE_KEYS.BACKUP_PRIVATE_KEY, V2_BACKUP_KEYCHAIN_SERVICE, true),
      publicSlot: v2(V2_STORAGE_KEYS.BACKUP_PUBLIC_KEY, V2_BACKUP_KEYCHAIN_SERVICE, false),
    },
    {
      label: 'backup-timestamp',
      kind: 'value',
      slot: v2(V2_STORAGE_KEYS.BACKUP_TIMESTAMP, V2_BACKUP_KEYCHAIN_SERVICE, false),
    },
    {
      label: 'legacy-primary',
      kind: 'pair',
      privateSlot: legacy(STORAGE_KEYS.PRIVATE_KEY, true),
      publicSlot: legacy(STORAGE_KEYS.PUBLIC_KEY, false),
    },
    {
      label: 'legacy-backup',
      kind: 'pair',
      privateSlot: legacy(STORAGE_KEYS.BACKUP_PRIVATE_KEY, true),
      publicSlot: legacy(STORAGE_KEYS.BACKUP_PUBLIC_KEY, false),
    },
    {
      label: 'legacy-backup-timestamp',
      kind: 'value',
      slot: legacy(STORAGE_KEYS.BACKUP_TIMESTAMP, false),
    },
    {
      label: 'phrase',
      kind: 'value',
      slot: slot(
        RECOVERY_MNEMONIC_STORAGE_KEY,
        'identity-secret',
        RECOVERY_MNEMONIC_KEYCHAIN_SERVICE,
      ),
    },
    {
      // The private key moves to the wallet group; its public key stays shared.
      label: 'shared-slot',
      kind: 'pair',
      privateSlot: slot(STORAGE_KEYS.SHARED_PRIVATE_KEY, 'spending-key'),
      publicSlot: slot(STORAGE_KEYS.SHARED_PUBLIC_KEY, 'shared', undefined, false),
    },
  ];
}

const INDEX_SLOT = slot(
  ORGANIZATION_INDEX_STORAGE_KEY,
  'identity-secret',
  ORGANIZATION_INDEX_KEYCHAIN_SERVICE,
  false,
);

/** Union of two indexes; never drops an id either side lists. */
function mergeIndexes(shared: string, target: string): string | null {
  return serializeOrganizationIndex([
    ...parseOrganizationIndex(shared),
    ...parseOrganizationIndex(target),
  ]);
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
  try {
    for (const unit of personalUnits()) {
      items[unit.label] = await mover.move(unit);
    }
    // Organizations: every id either copy of the index names.
    const ids = new Set([
      ...parseOrganizationIndex(await mover.read(INDEX_SLOT, 'shared')),
      ...parseOrganizationIndex(await mover.read(INDEX_SLOT, INDEX_SLOT.group)),
    ]);
    let n = 0;
    for (const accountId of [...ids].sort()) {
      n += 1;
      items[`organization-${n}`] = await mover.move({
        label: `organization-${n}`,
        kind: 'pair',
        privateSlot: slot(organizationPrivateKeyName(accountId), 'spending-key'),
        publicSlot: slot(organizationPublicKeyName(accountId), 'spending-key', undefined, false),
      });
      items[`organization-${n}-phrase`] = await mover.move({
        label: `organization-${n}-phrase`,
        kind: 'value',
        slot: slot(
          organizationMnemonicName(accountId),
          'identity-secret',
          ORGANIZATION_MNEMONIC_KEYCHAIN_SERVICE,
        ),
      });
    }
    // The index last: it is how a later run finds the organizations above.
    items['organization-index'] = await mover.move({
      label: 'organization-index',
      kind: 'value',
      slot: INDEX_SLOT,
      merge: mergeIndexes,
    });
  } catch (error) {
    if (error instanceof Deferred) {
      return { state: 'deferred', items };
    }
    throw error;
  }
  const settled = Object.values(items).every((o) => o === 'absent' || o === 'moved');
  const report: KeychainGroupMigrationReport = {
    state: settled ? 'complete' : 'incomplete',
    items,
  };
  if (!settled) {
    logger.warn('Keychain access-group migration left items in the shared group', {
      component: 'KeychainGroupMigration',
      items: Object.entries(items)
        .filter(([, o]) => o !== 'absent' && o !== 'moved')
        .map(([label, o]) => `${label}:${o}`)
        .join(','),
    });
  }
  return report;
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
}
