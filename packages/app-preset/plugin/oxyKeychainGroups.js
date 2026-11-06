/**
 * Who may name which Oxy iOS keychain access group
 * (docs/identity/ios-keychain-access-groups.md, ADR 0062 in the oxy repo).
 *
 * | Group                  | Holders                               | Holds                                  |
 * |------------------------|---------------------------------------|----------------------------------------|
 * | `so.oxy.identity`      | Commons only, FIRST in its list       | the personal root, phrases, org index  |
 * | `so.oxy.wallet`        | Commons, the Peable wallet            | private keys the wallet signs with     |
 * | `group.so.oxy.shared`  | every Oxy app                         | public keys, the device-session credential |
 *
 * The first entry of `keychain-access-groups` is the app's DEFAULT group, and
 * `@oxy.so/core` reads its role from it at runtime: identity first is Commons,
 * wallet first is the Peable wallet, anything else holds no private key. So the
 * ORDER is part of the policy, not only the membership: Commons lists
 * `[identity, wallet, shared]`, the Peable wallet `[wallet, shared]`.
 *
 * Every other app keeps the shared group only. An app config that names a
 * restricted group without being its holder fails prebuild; the entitlement is
 * native, so this is the one place it can be stopped before it ships.
 */
const PREFIX = '$(AppIdentifierPrefix)';

const OXY_KEYCHAIN_GROUPS = Object.freeze({
  identity: 'so.oxy.identity',
  wallet: 'so.oxy.wallet',
  shared: 'group.so.oxy.shared',
});

const COMMONS = ['so.oxy.commons', 'so.oxy.commons.dev'];
const PEABLE_WALLET = ['to.peable.app', 'to.peable.app.dev'];

/** The exact leading entries each holder lists, by bundle id. */
const HOLDER_LAYOUTS = Object.freeze({
  ...Object.fromEntries(
    COMMONS.map((id) => [
      id,
      [OXY_KEYCHAIN_GROUPS.identity, OXY_KEYCHAIN_GROUPS.wallet, OXY_KEYCHAIN_GROUPS.shared],
    ]),
  ),
  ...Object.fromEntries(
    PEABLE_WALLET.map((id) => [id, [OXY_KEYCHAIN_GROUPS.wallet, OXY_KEYCHAIN_GROUPS.shared]]),
  ),
});

const RESTRICTED = new Set([OXY_KEYCHAIN_GROUPS.identity, OXY_KEYCHAIN_GROUPS.wallet]);

/** `$(AppIdentifierPrefix)so.oxy.wallet` → `so.oxy.wallet`. */
function groupName(entry) {
  return typeof entry === 'string' && entry.startsWith(PREFIX) ? entry.slice(PREFIX.length) : entry;
}

/** The entitlement entries for these group names, in order. */
function keychainEntries(groups) {
  return groups.map((group) => `${PREFIX}${group}`);
}

/**
 * The groups this app should list: its holder layout, or the shared group.
 * @param {string|undefined} bundleId
 */
function keychainGroupsFor(bundleId) {
  return HOLDER_LAYOUTS[bundleId] ? [...HOLDER_LAYOUTS[bundleId]] : [OXY_KEYCHAIN_GROUPS.shared];
}

/**
 * Throw unless `entries` (a `keychain-access-groups` value) is one this bundle
 * id may ship: a restricted group only for its holders, and a holder's layout
 * as the leading entries, in order.
 *
 * @param {string|undefined} bundleId
 * @param {unknown} entries
 */
function assertOxyKeychainGroups(bundleId, entries) {
  if (!Array.isArray(entries)) return;
  const names = entries.map(groupName);
  const layout = HOLDER_LAYOUTS[bundleId];
  for (const name of names) {
    if (RESTRICTED.has(name) && !layout?.includes(name)) {
      throw new Error(
        `[@oxy.so/app-preset] ${bundleId ?? 'This app'} may not list the keychain access group "${name}": ` +
          'only Commons holds the identity group and only Commons and the Peable wallet the wallet group ' +
          '(docs/identity/ios-keychain-access-groups.md). Every other Oxy app lists group.so.oxy.shared.',
      );
    }
  }
  const namesRestricted = names.some((name) => RESTRICTED.has(name));
  if (layout && namesRestricted) {
    const leading = names.slice(0, layout.length);
    if (leading.join(',') !== layout.join(',')) {
      throw new Error(
        `[@oxy.so/app-preset] ${bundleId} must list its keychain access groups as [${layout.join(', ')}] ` +
          `first, in that order (got [${names.join(', ')}]): the first entry is the default group, ` +
          'which decides where the identity is written and what @oxy.so/core lets this app read.',
      );
    }
  }
}

module.exports = {
  OXY_KEYCHAIN_GROUPS,
  HOLDER_LAYOUTS,
  assertOxyKeychainGroups,
  keychainEntries,
  keychainGroupsFor,
  groupName,
};
