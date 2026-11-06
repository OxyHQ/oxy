/**
 * Who may name which Oxy iOS keychain access group
 * (docs/identity/ios-keychain-access-groups.md, ADR 0062 in the oxy repo).
 *
 * | Group                  | Holders                                   | Holds                                  |
 * |------------------------|-------------------------------------------|----------------------------------------|
 * | `so.oxy.identity`      | Commons only, FIRST in its list           | the personal root, phrases, org index  |
 * | `so.oxy.wallet`        | Commons, the Peable wallet                | private keys the wallet signs with     |
 * | `so.oxy.identity.dev`  | Commons' DEV build only, FIRST            | the same, for the dev build            |
 * | `so.oxy.wallet.dev`    | the DEV builds of Commons and the wallet  | the same, for the dev builds           |
 * | `group.so.oxy.shared`  | every Oxy app                             | public keys, the device-session credential |
 *
 * The first entry of `keychain-access-groups` is the app's DEFAULT group, and
 * `@oxy.so/core` reads its role from it at runtime: identity first is Commons,
 * wallet first is the Peable wallet, anything else holds no private key. So the
 * ORDER is part of the policy, not only the membership: Commons lists
 * `[identity, wallet, shared]`, the Peable wallet `[wallet, shared]`.
 *
 * The DEV builds (`so.oxy.commons.dev`, `to.peable.app.dev`) sit next to the
 * production apps on the same phone, are signed by the same team and run
 * JavaScript from a dev server, so they never get the production restricted
 * groups: they hold the `.dev` ones, and a production id may not name those.
 *
 * Every entry is NORMALISED before it is judged (`normalizeGroupName`): leading
 * build variables (`$(AppIdentifierPrefix)`, `$(TeamIdentifierPrefix)`,
 * `${…}`, nested), a leading ten-character team id and surrounding whitespace
 * are stripped, and the name is compared without case. An entry that names a
 * restricted group must then be spelled EXACTLY `$(AppIdentifierPrefix)<group>`
 * (or `<TEAMID>.<group>` when checking built entitlements for that team), and
 * an entry still carrying a build variable or a wildcard after normalisation
 * cannot be judged and is refused.
 *
 * Every other app keeps the shared group only. An app config that names a
 * restricted group without being its holder fails prebuild; the entitlement is
 * native, so this is the one place it can be stopped before it ships.
 */
const PREFIX = '$(AppIdentifierPrefix)';

const OXY_KEYCHAIN_GROUPS = Object.freeze({
  identity: 'so.oxy.identity',
  wallet: 'so.oxy.wallet',
  identityDev: 'so.oxy.identity.dev',
  walletDev: 'so.oxy.wallet.dev',
  shared: 'group.so.oxy.shared',
});

const G = OXY_KEYCHAIN_GROUPS;

/** The exact leading entries each holder lists, by bundle id. */
const HOLDER_LAYOUTS = Object.freeze({
  'so.oxy.commons': Object.freeze([G.identity, G.wallet, G.shared]),
  'so.oxy.commons.dev': Object.freeze([G.identityDev, G.walletDev, G.shared]),
  'to.peable.app': Object.freeze([G.wallet, G.shared]),
  'to.peable.app.dev': Object.freeze([G.walletDev, G.shared]),
});

/** Lower-cased restricted name → its canonical spelling. */
const RESTRICTED = new Map(
  [G.identity, G.wallet, G.identityDev, G.walletDev].map((name) => [name.toLowerCase(), name]),
);

const TEAM_ID = /^[A-Z0-9]{10}$/;
const LEADING_TEAM_ID = /^[A-Z0-9]{10}\./i;

/**
 * Length of the build variable (`$(…)` or `${…}`, nesting allowed) at the start
 * of `text`, or 0 when it does not start with a complete one.
 */
function leadingVariableLength(text) {
  if (text[0] !== '$' || (text[1] !== '(' && text[1] !== '{')) return 0;
  const stack = [];
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '{') stack.push(ch === '(' ? ')' : '}');
    else if (ch === ')' || ch === '}') {
      if (stack.pop() !== ch) return 0;
      if (stack.length === 0) return i + 1;
    }
  }
  return 0;
}

/**
 * The group an entry names, with every way of spelling its team prefix
 * removed: `$(AppIdentifierPrefix)so.oxy.wallet`, `$(TeamIdentifierPrefix)
 * so.oxy.wallet`, `ABCDE12345.so.oxy.wallet` → `so.oxy.wallet`. Case is kept;
 * compare with `restrictedGroup`, which ignores it.
 *
 * @param {string} entry
 */
function normalizeGroupName(entry) {
  let rest = entry.trim();
  for (;;) {
    const variable = leadingVariableLength(rest);
    if (variable > 0) {
      rest = rest.slice(variable).trim();
      continue;
    }
    const team = LEADING_TEAM_ID.exec(rest);
    if (team) {
      rest = rest.slice(team[0].length).trim();
      continue;
    }
    return rest;
  }
}

/** The canonical restricted group a normalised name is, in any case, or undefined. */
function restrictedGroup(name) {
  return RESTRICTED.get(name.toLowerCase());
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
  return Object.hasOwn(HOLDER_LAYOUTS, bundleId ?? '') ? [...HOLDER_LAYOUTS[bundleId]] : [G.shared];
}

function refuse(message) {
  throw new Error(`[@oxy.so/app-preset] ${message} (docs/identity/ios-keychain-access-groups.md)`);
}

/**
 * Throw unless `entries` (a `keychain-access-groups` value) is one this bundle
 * id may ship: every entry judgeable, a restricted group only for its holders
 * and only in its one spelling, and a holder's layout as the leading entries,
 * in order.
 *
 * @param {string|undefined} bundleId
 * @param {unknown} entries
 * @param {{ teamId?: string }} [options] `teamId`: the entries are BUILT
 *   (codesigned) entitlements of that team, so a restricted group is spelled
 *   `<teamId>.<group>` instead of `$(AppIdentifierPrefix)<group>`.
 */
function assertOxyKeychainGroups(bundleId, entries, options = {}) {
  if (entries === undefined || entries === null) return;
  const app = bundleId ?? 'This app';
  if (!Array.isArray(entries)) {
    refuse(`${app}: keychain-access-groups must be an array of strings`);
  }
  const { teamId } = options;
  if (teamId !== undefined && !TEAM_ID.test(teamId)) {
    refuse(`"${teamId}" is not an Apple team id (ten upper-case letters and digits)`);
  }
  const layout = Object.hasOwn(HOLDER_LAYOUTS, bundleId ?? '') ? HOLDER_LAYOUTS[bundleId] : [];

  const names = entries.map((entry) => {
    if (typeof entry !== 'string') {
      refuse(`${app}: every keychain-access-groups entry must be a string`);
    }
    const name = normalizeGroupName(entry);
    if (name === '' || /[$*?\s]/.test(name)) {
      refuse(
        `${app}: the keychain access group "${entry}" cannot be checked (a build variable, wildcard or ` +
          'whitespace past its team prefix). Name the group literally after $(AppIdentifierPrefix).',
      );
    }
    const restricted = restrictedGroup(name);
    if (restricted === undefined) return name;
    if (!layout.includes(restricted)) {
      refuse(
        `${app} may not list the keychain access group "${entry}" (${restricted}): only Commons holds ` +
          'the identity group and only Commons and the Peable wallet the wallet group, the production ' +
          'apps the production groups and their dev builds the .dev groups. Every other Oxy app lists ' +
          'group.so.oxy.shared',
      );
    }
    const pinned = teamId === undefined ? `${PREFIX}${restricted}` : `${teamId}.${restricted}`;
    if (entry !== pinned) {
      refuse(`${app} must spell the keychain access group "${entry}" exactly "${pinned}"`);
    }
    return restricted;
  });

  if (layout.length > 0 && names.some((name) => restrictedGroup(name) !== undefined)) {
    const leading = names.slice(0, layout.length);
    if (leading.join(',') !== layout.join(',')) {
      refuse(
        `${bundleId} must list its keychain access groups as [${layout.join(', ')}] first, in that ` +
          `order (got [${names.join(', ')}]): the first entry is the default group, which decides ` +
          'where the identity is written and what @oxy.so/core lets this app read',
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
  normalizeGroupName,
  restrictedGroup,
};
