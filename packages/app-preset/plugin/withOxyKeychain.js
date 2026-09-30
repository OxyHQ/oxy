/**
 * Expo Config Plugin: withOxyKeychain
 *
 * Adds an iOS `keychain-access-groups` entitlement so Oxy apps signed with the
 * same Team ID can share Keychain items — the iOS half of "sign in once, use
 * everywhere" (the Android half is Commons' identity host, reached over
 * signature-protected IPC; see `withOxySharedPermissions` in @oxy.so/services). The group is prefixed with `$(AppIdentifierPrefix)` so Xcode
 * expands it to the Team ID at build time.
 *
 * Merge-not-overwrite: if the app (or another plugin, e.g. expo-build-properties)
 * already declared keychain-access-groups, the Oxy group is appended without
 * dropping the existing entries.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @param {string} [keychainGroup='group.so.oxy.shared'] The keychain group,
 *   without the `$(AppIdentifierPrefix)` prefix.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withOxyKeychain(config, keychainGroup = 'group.so.oxy.shared') {
  const entry = `$(AppIdentifierPrefix)${keychainGroup}`;

  return withEntitlementsPlist(config, (config) => {
    const key = 'keychain-access-groups';
    const existing = config.modResults[key];
    const groups = Array.isArray(existing) ? [...existing] : [];

    if (!groups.includes(entry)) {
      groups.push(entry);
    }

    config.modResults[key] = groups;
    return config;
  });
};
