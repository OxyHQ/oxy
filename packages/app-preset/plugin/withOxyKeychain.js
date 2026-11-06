/**
 * Expo Config Plugin: withOxyKeychain
 *
 * Adds the iOS `keychain-access-groups` entitlement an Oxy app needs, prefixed
 * with `$(AppIdentifierPrefix)` so Xcode expands it to the Team ID at build
 * time. Which groups, and in which order, is `./oxyKeychainGroups`: every app
 * the shared group (`group.so.oxy.shared`: public keys and the device-session
 * credential), Commons `[so.oxy.identity, so.oxy.wallet, group.so.oxy.shared]`
 * and the Peable wallet `[so.oxy.wallet, group.so.oxy.shared]` — the first
 * entry is the default group, so it is part of the rule. The Android half is
 * Commons' identity host (`withOxySharedPermissions` in @oxy.so/services).
 *
 * The Oxy groups are put FIRST, in their order; entries the app or another
 * plugin already declared are kept after them. Then the policy is checked on
 * the result, and on the app's own `ios.entitlements`: an app that is not a
 * holder and names the identity or wallet group fails prebuild.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @param {string|string[]} [keychainGroups] Group name(s) without the prefix.
 *   Default: what `keychainGroupsFor(ios.bundleIdentifier)` gives.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');
const {
  assertOxyKeychainGroups,
  groupName,
  keychainEntries,
  keychainGroupsFor,
} = require('./oxyKeychainGroups');

const KEY = 'keychain-access-groups';

/** Check the groups an app config declares itself (`ios.entitlements`). */
function withOxyKeychainPolicy(config) {
  const bundleId = config.ios?.bundleIdentifier;
  assertOxyKeychainGroups(bundleId, config.ios?.entitlements?.[KEY]);
  return withEntitlementsPlist(config, (config) => {
    assertOxyKeychainGroups(bundleId, config.modResults[KEY]);
    return config;
  });
}

function withOxyKeychain(config, keychainGroups) {
  const bundleId = config.ios?.bundleIdentifier;
  const wanted = keychainEntries(
    keychainGroups === undefined
      ? keychainGroupsFor(bundleId)
      : Array.isArray(keychainGroups)
        ? keychainGroups
        : [keychainGroups],
  );
  // At config time, not only in the mod: a refused group fails `expo config` too.
  assertOxyKeychainGroups(bundleId, wanted);
  assertOxyKeychainGroups(bundleId, config.ios?.entitlements?.[KEY]);

  const next = withEntitlementsPlist(config, (config) => {
    const existing = Array.isArray(config.modResults[KEY]) ? config.modResults[KEY] : [];
    const wantedNames = new Set(wanted.map(groupName));
    const rest = existing.filter((entry) => !wantedNames.has(groupName(entry)));
    const groups = [...wanted, ...rest];
    assertOxyKeychainGroups(bundleId, groups);
    config.modResults[KEY] = groups;
    return config;
  });
  return next;
}

module.exports = withOxyKeychain;
module.exports.withOxyKeychainPolicy = withOxyKeychainPolicy;
