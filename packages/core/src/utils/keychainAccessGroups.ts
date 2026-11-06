/**
 * iOS keychain access groups: which group each Oxy keychain item lives in, and
 * which apps may read it (docs/identity/ios-keychain-access-groups.md, ADR 0062).
 *
 * | Group                         | Held by                      | Item class        |
 * |-------------------------------|------------------------------|-------------------|
 * | `<TEAM>.so.oxy.identity`      | Commons only (listed FIRST)  | `identity-secret` |
 * | `<TEAM>.so.oxy.wallet`        | Commons, the Peable wallet   | `spending-key`    |
 * | `<TEAM>.group.so.oxy.shared`  | every Oxy app                | `shared`          |
 * | `<TEAM>.<bundle id>`          | that app alone               | `app`             |
 *
 * - `identity-secret`: the personal root (primary and backup slots), the
 *   personal and organization recovery phrases, the organization index. Only
 *   Commons may read or write them.
 * - `spending-key`: private keys an app other than Commons signs or derives
 *   with in process — the personal key's shared slot and organization pairs
 *   (`deriveScopedSeed`, `signSocialReceive`). Commons writes them; the Peable
 *   wallet reads them.
 * - `shared`: what every Oxy app may read: the shared public key and the
 *   device-session credential (the one cross-app session join point).
 * - `app`: an app's OWN items, readable by no other app: its session
 *   credential (`oxy.auth.v1` and the rest of the SDK's session store), its
 *   identity pin, its settings, the Peable wallet's imported phrases. The group
 *   is the app's application identifier, which Apple makes every app a member
 *   of; no app lists it and no other app can name it. Android's counterpart is
 *   the app's own storage (ADR 0062 D6).
 *
 * The ROLE of this binary comes from the keychain itself: an item written
 * without a group lands in the app's default group, the first entry of its
 * `keychain-access-groups` entitlement, and `@oxy.so/app-preset` lets only
 * Commons put the identity group first and only the Peable wallet the wallet
 * group. The same probe gives the team prefix, which `kSecAttrAccessGroup`
 * needs and JavaScript cannot otherwise see; a second probe proves the app's
 * own group (`<prefix><bundle id>`) is writable.
 *
 * Android and web have no access groups: there every helper here answers the
 * single-store behaviour (`ungrouped`), and Android's narrowing is Commons'
 * identity host. An iOS build whose native module predates the probe is also
 * `ungrouped` — exactly what that build's entitlements (one shared group) do.
 *
 * This module never imports the identity stack: services' device-session store
 * and Peable's wallet storage use it too.
 */
import {
  type KeychainApplicationAccessGroup,
  type KeychainDefaultAccessGroup,
  loadKeychainApplicationAccessGroup,
  loadKeychainDefaultAccessGroup,
} from '@oxy.so/protocol';
import { isIOS } from './platform';

/** The group names after the team prefix, exactly as the entitlements list them. */
export const KEYCHAIN_ACCESS_GROUPS = {
  identity: 'so.oxy.identity',
  wallet: 'so.oxy.wallet',
  shared: 'group.so.oxy.shared',
} as const;

/**
 * The suffix a DEVELOPMENT build's restricted groups carry (`so.oxy.commons.dev`,
 * `to.peable.app.dev`: `so.oxy.identity.dev`, `so.oxy.wallet.dev`). A dev build
 * sits beside the production app on the same phone, is signed by the same team
 * and runs JavaScript from a dev server, so it never shares a restricted group
 * with production (`@oxy.so/app-preset` enforces the entitlements). The shared
 * group has no variant: it holds nothing secret.
 */
export const DEV_KEYCHAIN_GROUP_SUFFIX = '.dev' as const;

export type KeychainAccessGroupName = keyof typeof KEYCHAIN_ACCESS_GROUPS;

/**
 * Every group an item class can be assigned: the three Oxy groups, or `app`,
 * this app's own group, whose name is the app's and so is not a constant.
 */
export type KeychainGroup = KeychainAccessGroupName | 'app';

/** What a keychain item IS, which decides its group. See the table above. */
export type KeychainItemClass = 'identity-secret' | 'spending-key' | 'shared' | 'app';

/** Which holder this binary is, from its default access group. */
export type KeychainRole = 'holder' | 'wallet' | 'member';

/**
 * - `grouped`: iOS with the probe answered. `prefix` ends with its dot
 *   (`ABCDE12345.`); `defaultGroup` is the full default group string;
 *   `appGroup`, when the native module proved it, this app's own group
 *   (`ABCDE12345.so.oxy.mention`). Absent on a native build that predates that
 *   probe: see {@link ownKeychainItemPlan} for what such a build does.
 * - `ungrouped`: Android, web, or an iOS native build without the probe.
 */
export type KeychainAccess =
  | {
      mode: 'grouped';
      prefix: string;
      defaultGroup: string;
      role: KeychainRole;
      appGroup?: string;
      /** {@link DEV_KEYCHAIN_GROUP_SUFFIX} for a dev build; absent for production. */
      variant?: typeof DEV_KEYCHAIN_GROUP_SUFFIX;
    }
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
export function keychainGroupFor(item: Exclude<KeychainItemClass, 'app'>): KeychainAccessGroupName;
export function keychainGroupFor(item: KeychainItemClass): KeychainGroup;
export function keychainGroupFor(item: KeychainItemClass): KeychainGroup {
  switch (item) {
    case 'identity-secret':
      return 'identity';
    case 'spending-key':
      return 'wallet';
    case 'shared':
      return 'shared';
    case 'app':
      return 'app';
  }
}

/**
 * Whether `role` may WRITE `item`. Only Commons writes a secret: the Peable
 * wallet reads, derives and signs with spending keys (and the retired ring)
 * but never adds one — a key the wallet could add is one the wallet could
 * choose. (The keychain itself lets every app in the wallet group write it;
 * this is the SDK's half, and readers check what they find, ADR 0062.)
 */
export function mayWriteKeychainItem(role: KeychainRole, item: KeychainItemClass): boolean {
  return role === 'holder' || item === 'shared' || item === 'app';
}

/** Whether `role` holds the group `item` lives in. */
export function mayHoldKeychainItem(role: KeychainRole, item: KeychainItemClass): boolean {
  switch (role) {
    case 'holder':
      return true;
    case 'wallet':
      return item !== 'identity-secret';
    case 'member':
      return item === 'shared' || item === 'app';
  }
}

/**
 * Parse the default access group the probe reported, and the app's own group
 * when the second probe proved it. Exported for tests.
 */
export function keychainAccessFromDefaultGroup(
  defaultGroup: string,
  appGroup?: string,
): KeychainAccess {
  const dot = defaultGroup.indexOf('.');
  if (dot <= 0 || dot === defaultGroup.length - 1) {
    // Not `<prefix>.<group>`: an unsigned simulator build. Nothing to split.
    return { mode: 'ungrouped' };
  }
  const prefix = defaultGroup.slice(0, dot + 1);
  const group = defaultGroup.slice(dot + 1);
  const dev = group.endsWith(DEV_KEYCHAIN_GROUP_SUFFIX);
  const base = dev ? group.slice(0, -DEV_KEYCHAIN_GROUP_SUFFIX.length) : group;
  const role: KeychainRole =
    base === KEYCHAIN_ACCESS_GROUPS.identity
      ? 'holder'
      : base === KEYCHAIN_ACCESS_GROUPS.wallet
        ? 'wallet'
        : 'member';
  // A `.dev` suffix on anything but a restricted group is not a variant.
  const variant = dev && role !== 'member' ? { variant: DEV_KEYCHAIN_GROUP_SUFFIX } : {};
  return appGroup?.startsWith(prefix)
    ? { mode: 'grouped', prefix, defaultGroup, role, appGroup, ...variant }
    : { mode: 'grouped', prefix, defaultGroup, role, ...variant };
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
    // Not memoized: until `@oxy.so/services` registers the platform, a phone
    // reads as "not iOS", and caching that would keep the whole process on the
    // pre-split behaviour.
    return { mode: 'ungrouped' };
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
  if (probe.state !== 'resolved') {
    resolvedAccess = { mode: 'ungrouped' };
    return resolvedAccess;
  }
  const access = keychainAccessFromDefaultGroup(probe.accessGroup);
  if (access.mode === 'ungrouped') {
    resolvedAccess = access;
    return resolvedAccess;
  }
  // The app's own group. A thrown probe is NOT degraded to "no app group": this
  // process would then write the app's items to the old place while the next
  // one reads the new place first, and see a stale value.
  let own: KeychainApplicationAccessGroup;
  try {
    own = await loadKeychainApplicationAccessGroup(access.prefix);
  } catch (cause) {
    throw new KeychainAccessUnavailableError(cause);
  }
  if (own.state === 'unavailable') {
    throw new KeychainAccessUnavailableError(own.cause);
  }
  resolvedAccess = keychainAccessFromDefaultGroup(
    probe.accessGroup,
    own.state === 'resolved' ? own.accessGroup : undefined,
  );
  return resolvedAccess;
}

/** Forget the memoized access and the fallback state. Tests only. @internal */
export function resetKeychainAccessForTests(): void {
  resolvedAccess = null;
  holderSharedFallback = false;
  walletSharedFallbackClosed = false;
}

/**
 * The full `kSecAttrAccessGroup` value of `group`, or `undefined` for "no
 * group" (the app's default): always when ungrouped, and for `app` on a build
 * that cannot place items there (see {@link ownKeychainItemPlan}).
 */
export function keychainAccessGroupValue(
  access: KeychainAccess,
  group: KeychainGroup,
): string | undefined {
  if (access.mode === 'ungrouped') {
    return undefined;
  }
  if (group === 'app') {
    // Commons' and the Peable wallet's default groups are theirs (no other app
    // writes its own items there), so a build without the app-group probe
    // keeps its own items there, as ADR 0062 D3 put them. Every other app's
    // default is the shared group: no group, the calls it always made.
    return access.appGroup ?? (access.role === 'member' ? undefined : access.defaultGroup);
  }
  const variant = group === 'shared' ? '' : (access.variant ?? '');
  return `${access.prefix}${KEYCHAIN_ACCESS_GROUPS[group]}${variant}`;
}

/**
 * Whether a SECRET read may still fall back to the pre-split shared group
 * (R4-7). Every Oxy app can write that group, and keychain items survive an
 * uninstall, so a secret found there is one Commons did not necessarily write.
 *
 * - Commons (`holder`): CLOSED, except while its one-shot migration has proved
 *   the shared copies are its own (they carry the key its sandbox marker
 *   records) and could not move them all yet; the migration opens it for that
 *   launch only ({@link setHolderSharedSecretFallback}).
 * - The Peable wallet: open until Commons' migration has finished (the
 *   completion record Commons mirrors into the wallet group), because until
 *   then an upgraded phone's keys are still in the shared group; closed for
 *   good once it has seen that record ({@link closeWalletSharedSecretFallback}).
 */
let holderSharedFallback = false;
let walletSharedFallbackClosed = false;

/** The migration's switch for Commons' fallback. @internal */
export function setHolderSharedSecretFallback(open: boolean): void {
  holderSharedFallback = open;
}

/** The wallet saw Commons' completion record: no shared fallback again in this process. @internal */
export function closeWalletSharedSecretFallback(): void {
  walletSharedFallbackClosed = true;
}

function sharedFallbackOpen(access: Extract<KeychainAccess, { mode: 'grouped' }>): boolean {
  switch (access.role) {
    case 'holder':
      return holderSharedFallback;
    case 'wallet':
      return !walletSharedFallbackClosed;
    case 'member':
      return false;
  }
}

function option(value: string | undefined): KeychainGroupOption {
  return value === undefined ? {} : { accessGroup: value };
}

/**
 * The option bags a READ of `item` tries, in order: its own group, then — for
 * an identity secret or a spending key, and only while
 * {@link sharedFallbackOpen} says so — the shared group, where those lived
 * before the split. Empty when this app may not hold the item: the caller
 * answers `null` without touching the keychain. Evaluated per read: the
 * fallback closes during a process's life. An app's own items (`app`) take
 * {@link ownKeychainItemPlan}.
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
  if ((own === 'identity' || own === 'wallet') && sharedFallbackOpen(access)) {
    plan.push(option(keychainAccessGroupValue(access, 'shared')));
  }
  return plan;
}

/**
 * Every place a DELETE of `item` must reach: its own group AND the shared
 * group, whatever the read fallback says, so a delete never leaves a copy
 * behind where every Oxy app can read it.
 */
export function keychainDeletePlan(
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
  if (own === 'identity' || own === 'wallet') {
    plan.push(option(keychainAccessGroupValue(access, 'shared')));
  }
  return plan;
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
  if (!mayWriteKeychainItem(access.role, item)) {
    throw new Error(
      `This app (keychain role "${access.role}") may not write a ${item} keychain item; only Commons writes the identity and the keys the wallet spends.`,
    );
  }
  return option(keychainAccessGroupValue(access, keychainGroupFor(item)));
}

/**
 * Who else writes an own item's NAME, which decides whose an earlier copy of
 * it can be.
 *
 * - `this-app`: no other app uses the name (the Peable wallet's own items). A
 *   copy anywhere this app can read is its own.
 * - `every-oxy-app`: every Oxy app writes the same name (the SDK's session
 *   store: `oxy.auth.v1`, the warm token, the identity pin). Before the
 *   app group, every iOS app but Commons and the Peable wallet wrote it to the
 *   ONE copy in the shared group, so a copy there may be another app's
 *   session, or Commons' vault session. Only this app's own locations are
 *   read, written or deleted; the shared copy is left to the apps still
 *   running a build that uses it.
 * - `every-oxy-app-withholding`: as `every-oxy-app`, for a value whose only
 *   effect is to WITHHOLD (the explicit sign-out marker). A shared copy still
 *   counts — honouring another app's marker can keep this app from signing in
 *   automatically, never sign it in — and its delete reaches that copy, as a
 *   release always did before.
 */
export type OwnKeychainItemNames = 'this-app' | 'every-oxy-app' | 'every-oxy-app-withholding';

/**
 * The plan for an app's OWN items (class `app`, ADR 0062 D6): written to the
 * app's own group (`<prefix><bundle id>`), which no other app can read, and
 * read from it FIRST. Then:
 *
 * - from where this app kept them before: Commons' and the Peable wallet's
 *   default group (D3), which no other app writes its own items to;
 * - for `this-app` names, from every group (`{}`), where they were before the
 *   split; deletes reach every group;
 * - for `every-oxy-app` names, nowhere else (see {@link OwnKeychainItemNames}),
 *   and deletes reach exactly the read locations, earlier ones first, so a
 *   failed delete never leaves an older copy as the only one;
 * - for `every-oxy-app-withholding` names, the shared group last on read and
 *   first on delete.
 *
 * Nothing is copied or deleted to migrate: the next write lands in the app
 * group and the read order makes it win, so a crash or a failure at any step
 * leaves the value the app had.
 *
 * A native build whose module predates the app-group probe (`appGroup`
 * absent) keeps its items where that build put them: Commons and the wallet in
 * their default group, every other app the calls it always made (the one
 * shared item, until that app's next native build). Android and web: no
 * options.
 */
export function ownKeychainItemPlan(
  access: KeychainAccess,
  names: OwnKeychainItemNames = 'this-app',
): {
  read: KeychainGroupOption[];
  write: KeychainGroupOption;
  delete: KeychainGroupOption[];
} {
  if (access.mode === 'ungrouped') {
    return { read: [{}], write: {}, delete: [{}] };
  }
  const own = keychainAccessGroupValue(access, keychainGroupFor('app'));
  if (own === undefined) {
    return { read: [{}], write: {}, delete: [{}] };
  }
  const earlier =
    access.role !== 'member' && own !== access.defaultGroup ? [option(access.defaultGroup)] : [];
  const mine = [option(own), ...earlier];
  switch (names) {
    case 'this-app':
      return { read: [...mine, {}], write: option(own), delete: [{}] };
    case 'every-oxy-app':
      return { read: mine, write: option(own), delete: [...mine].reverse() };
    case 'every-oxy-app-withholding': {
      const read = [...mine, option(keychainAccessGroupValue(access, 'shared'))];
      return { read, write: option(own), delete: [...read].reverse() };
    }
  }
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
 * the read plan (evaluated per read), writes carry the write option (throwing
 * for a role that may not write the item), deletes reach every location. A
 * secret WRITE also deletes the item's copy in the shared group (R4-6): a value
 * Commons writes replaces whatever any app could read there, and a copy that
 * cannot be removed fails the write instead of staying readable. The constants
 * of the wrapped store are kept, so `store.WHEN_UNLOCKED_THIS_DEVICE_ONLY` still
 * reads.
 */
export function groupedKeychainStore<S extends KeychainStoreLike>(
  store: S,
  access: KeychainAccess,
  item: KeychainItemClass,
): S {
  const sharedCopy =
    access.mode === 'grouped' && (item === 'identity-secret' || item === 'spending-key')
      ? option(keychainAccessGroupValue(access, 'shared'))
      : null;
  const wrapped: KeychainStoreLike = {
    getItemAsync: (key, options) =>
      readThroughPlan(store, key, options ?? {}, keychainReadPlan(access, item)),
    setItemAsync: async (key, value, options) => {
      const group = keychainWriteOption(access, item);
      await store.setItemAsync(key, value, { ...(options ?? {}), ...group });
      if (sharedCopy) {
        const { keychainAccessible: _accessible, ...rest } = (options ?? {}) as Record<
          string,
          unknown
        >;
        await store.deleteItemAsync(key, { ...rest, ...sharedCopy });
      }
    },
    deleteItemAsync: (key, options) =>
      deleteThroughPlan(store, key, options ?? {}, keychainDeletePlan(access, item)),
  };
  return Object.assign(Object.create(store) as S, wrapped);
}
