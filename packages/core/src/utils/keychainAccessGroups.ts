/**
 * iOS keychain access groups: which group each Oxy keychain item lives in, and
 * which apps may read it (docs/identity/ios-keychain-access-groups.md, ADR 0062).
 *
 * | Group                         | Held by                      | Item class        |
 * |-------------------------------|------------------------------|-------------------|
 * | `<TEAM>.so.oxy.identity`      | Commons only (listed FIRST)  | `identity-secret` |
 * | `<TEAM>.so.oxy.wallet`        | Commons, the Peable wallet   | `spending-key`    |
 * | `<TEAM>.group.so.oxy.shared`  | every Oxy app                | `shared`          |
 *
 * - `identity-secret`: the personal root (primary and backup slots), the
 *   personal and organization recovery phrases, the organization index. Only
 *   Commons may read or write them.
 * - `spending-key`: private keys an app other than Commons signs or derives
 *   with in process — the personal key's shared slot and organization pairs
 *   (`deriveScopedSeed`, `signSocialReceive`). Commons writes them; the Peable
 *   wallet reads them.
 * - `shared`: what every Oxy app may read: the shared public key and the
 *   device-session credential.
 *
 * The ROLE of this binary comes from the keychain itself: an item written
 * without a group lands in the app's default group, the first entry of its
 * `keychain-access-groups` entitlement, and `@oxy.so/app-preset` lets only
 * Commons put the identity group first and only the Peable wallet the wallet
 * group. The same probe gives the team prefix, which `kSecAttrAccessGroup`
 * needs and JavaScript cannot otherwise see.
 *
 * Android and web have no access groups: there every helper here answers the
 * single-store behaviour (`ungrouped`), and Android's narrowing is Commons'
 * identity host. An iOS build whose native module predates the probe is also
 * `ungrouped` — exactly what that build's entitlements (one shared group) do.
 *
 * This module never imports the identity stack: services' device-session store
 * and Peable's wallet storage use it too.
 */
import { type KeychainDefaultAccessGroup, loadKeychainDefaultAccessGroup } from '@oxy.so/protocol';
import { isIOS } from './platform';

/** The group names after the team prefix, exactly as the entitlements list them. */
export const KEYCHAIN_ACCESS_GROUPS = {
  identity: 'so.oxy.identity',
  wallet: 'so.oxy.wallet',
  shared: 'group.so.oxy.shared',
} as const;

export type KeychainAccessGroupName = keyof typeof KEYCHAIN_ACCESS_GROUPS;

/** What a keychain item IS, which decides its group. See the table above. */
export type KeychainItemClass = 'identity-secret' | 'spending-key' | 'shared';

/** Which holder this binary is, from its default access group. */
export type KeychainRole = 'holder' | 'wallet' | 'member';

/**
 * - `grouped`: iOS with the probe answered. `prefix` ends with its dot
 *   (`ABCDE12345.`); `defaultGroup` is the full default group string.
 * - `ungrouped`: Android, web, or an iOS native build without the probe.
 */
export type KeychainAccess =
  | { mode: 'grouped'; prefix: string; defaultGroup: string; role: KeychainRole }
  | { mode: 'ungrouped' };

/** The `expo-secure-store` option this module sets (its real name since 58). */
export interface KeychainGroupOption {
  accessGroup?: string;
}

/** Thrown while the probe cannot answer (before first unlock). Transient. */
export class KeychainAccessUnavailableError extends Error {
  override readonly name = 'KeychainAccessUnavailableError';
  constructor(readonly cause?: unknown) {
    super('The keychain cannot say which access groups this app holds right now.');
  }
}

/**
 * The single place each item class is assigned a group. A new kind of item
 * (F1's retained keys, for one) picks its class and reuses everything below.
 */
export function keychainGroupFor(item: KeychainItemClass): KeychainAccessGroupName {
  switch (item) {
    case 'identity-secret':
      return 'identity';
    case 'spending-key':
      return 'wallet';
    case 'shared':
      return 'shared';
  }
}

/** Whether `role` holds the group `item` lives in. */
export function mayHoldKeychainItem(role: KeychainRole, item: KeychainItemClass): boolean {
  switch (role) {
    case 'holder':
      return true;
    case 'wallet':
      return item !== 'identity-secret';
    case 'member':
      return item === 'shared';
  }
}

/** Parse the default access group the probe reported. Exported for tests. */
export function keychainAccessFromDefaultGroup(defaultGroup: string): KeychainAccess {
  const dot = defaultGroup.indexOf('.');
  if (dot <= 0 || dot === defaultGroup.length - 1) {
    // Not `<prefix>.<group>`: an unsigned simulator build. Nothing to split.
    return { mode: 'ungrouped' };
  }
  const prefix = defaultGroup.slice(0, dot + 1);
  const group = defaultGroup.slice(dot + 1);
  const role: KeychainRole =
    group === KEYCHAIN_ACCESS_GROUPS.identity
      ? 'holder'
      : group === KEYCHAIN_ACCESS_GROUPS.wallet
        ? 'wallet'
        : 'member';
  return { mode: 'grouped', prefix, defaultGroup, role };
}

let resolvedAccess: KeychainAccess | null = null;

/**
 * This binary's keychain access, memoized once known. THROWS
 * {@link KeychainAccessUnavailableError} while the probe cannot answer, which
 * every caller already treats as "storage unavailable, retry".
 */
export async function resolveKeychainAccess(): Promise<KeychainAccess> {
  if (resolvedAccess) {
    return resolvedAccess;
  }
  if (!isIOS()) {
    resolvedAccess = { mode: 'ungrouped' };
    return resolvedAccess;
  }
  let probe: KeychainDefaultAccessGroup;
  try {
    probe = await loadKeychainDefaultAccessGroup();
  } catch (cause) {
    throw new KeychainAccessUnavailableError(cause);
  }
  if (probe.state === 'unavailable') {
    throw new KeychainAccessUnavailableError(probe.cause);
  }
  resolvedAccess =
    probe.state === 'resolved'
      ? keychainAccessFromDefaultGroup(probe.accessGroup)
      : { mode: 'ungrouped' };
  return resolvedAccess;
}

/** Forget the memoized access. Tests only. @internal */
export function resetKeychainAccessForTests(): void {
  resolvedAccess = null;
}

/** The full `kSecAttrAccessGroup` value of `group`, or `undefined` when ungrouped. */
export function keychainAccessGroupValue(
  access: KeychainAccess,
  group: KeychainAccessGroupName,
): string | undefined {
  return access.mode === 'grouped' ? `${access.prefix}${KEYCHAIN_ACCESS_GROUPS[group]}` : undefined;
}

function option(value: string | undefined): KeychainGroupOption {
  return value === undefined ? {} : { accessGroup: value };
}

/**
 * The option bags a READ of `item` tries, in order: its own group, then the
 * shared group, where every item lived before the split (release 4 of the doc
 * drops that fallback). Empty when this app may not hold the item: the caller
 * answers `null` without touching the keychain.
 */
export function keychainReadPlan(
  access: KeychainAccess,
  item: KeychainItemClass,
): KeychainGroupOption[] {
  if (access.mode === 'ungrouped') {
    return [{}];
  }
  if (!mayHoldKeychainItem(access.role, item)) {
    return [];
  }
  const own = keychainGroupFor(item);
  const plan = [option(keychainAccessGroupValue(access, own))];
  if (own !== 'shared') {
    plan.push(option(keychainAccessGroupValue(access, 'shared')));
  }
  return plan;
}

/**
 * Every place a DELETE of `item` must reach: the read plan, so a delete never
 * leaves a pre-split copy behind in the shared group.
 */
export function keychainDeletePlan(
  access: KeychainAccess,
  item: KeychainItemClass,
): KeychainGroupOption[] {
  return keychainReadPlan(access, item);
}

/**
 * The option a WRITE of `item` carries. THROWS when this app may not hold the
 * item: an identity secret written by any app but Commons would land in that
 * app's default group, a second holder nobody knows about.
 */
export function keychainWriteOption(
  access: KeychainAccess,
  item: KeychainItemClass,
): KeychainGroupOption {
  if (access.mode === 'ungrouped') {
    return {};
  }
  if (!mayHoldKeychainItem(access.role, item)) {
    throw new Error(
      `This app (keychain role "${access.role}") may not hold a ${item} keychain item; only Commons writes the identity.`,
    );
  }
  return option(keychainAccessGroupValue(access, keychainGroupFor(item)));
}

/**
 * The plan for an app's OWN items (its session credential, its settings, an
 * imported wallet's phrase) in Commons and the Peable wallet, whose default
 * group the split changed: written to the default group explicitly — where a
 * write without a group goes anyway — and read from it FIRST, then from every
 * group (`{}`), where all of them were written before. Without the explicit
 * order a read could return whichever of two copies the keychain met first.
 * Deletes reach every group, as they always did.
 *
 * Every other app (`member`) and Android/web keep the calls they always made.
 */
export function ownKeychainItemPlan(access: KeychainAccess): {
  read: KeychainGroupOption[];
  write: KeychainGroupOption;
  delete: KeychainGroupOption[];
} {
  if (access.mode === 'ungrouped' || access.role === 'member') {
    return { read: [{}], write: {}, delete: [{}] };
  }
  return {
    read: [option(access.defaultGroup), {}],
    write: option(access.defaultGroup),
    delete: [{}],
  };
}

/** The subset of `expo-secure-store` a grouped store wraps. */
export interface KeychainStoreLike {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
}

/** Read `key` through `plan`: the first non-null answer. A thrown read propagates. */
export async function readThroughPlan(
  store: KeychainStoreLike,
  key: string,
  options: object,
  plan: readonly KeychainGroupOption[],
): Promise<string | null> {
  for (const group of plan) {
    const value = await store.getItemAsync(key, { ...options, ...group });
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

/** Delete `key` from every location in `plan`. A thrown delete propagates. */
export async function deleteThroughPlan(
  store: KeychainStoreLike,
  key: string,
  options: object,
  plan: readonly KeychainGroupOption[],
): Promise<void> {
  for (const group of plan) {
    await store.deleteItemAsync(key, { ...options, ...group });
  }
}

/**
 * `store` with every call routed to `item`'s groups for this app: reads walk
 * the read plan, writes carry the write option (throwing for a role that may
 * not hold the item), deletes reach every location. The constants of the
 * wrapped store are kept, so `store.WHEN_UNLOCKED_THIS_DEVICE_ONLY` still reads.
 */
export function groupedKeychainStore<S extends KeychainStoreLike>(
  store: S,
  access: KeychainAccess,
  item: KeychainItemClass,
): S {
  const plan = keychainReadPlan(access, item);
  const wrapped: KeychainStoreLike = {
    getItemAsync: (key, options) => readThroughPlan(store, key, options ?? {}, plan),
    setItemAsync: async (key, value, options) => {
      const group = keychainWriteOption(access, item);
      await store.setItemAsync(key, value, { ...(options ?? {}), ...group });
    },
    deleteItemAsync: (key, options) => deleteThroughPlan(store, key, options ?? {}, plan),
  };
  return Object.assign(Object.create(store) as S, wrapped);
}
