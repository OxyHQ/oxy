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
 * Every entry is spelled EXACTLY `$(AppIdentifierPrefix)<group>` (or
 * `<TEAMID>.<group>` when checking built entitlements for that team). Any other
 * entry is NORMALISED (`normalizeGroupName`: leading build variables such as
 * `$(TeamIdentifierPrefix)` or `${…}`, nested, a leading ten-character team id
 * and surrounding whitespace are stripped, case is ignored) only to say why it
 * is refused: another spelling of an allowed group, a restricted group this
 * app does not hold, or a group that is not this app's at all. An entry still
 * carrying a build variable or a wildcard after normalisation cannot be judged.
 *
 * The list is EXACT, not a floor (R5-4). An app may list:
 *
 * | Bundle id                       | `keychain-access-groups`                         |
 * |---------------------------------|--------------------------------------------------|
 * | `so.oxy.commons`                | `[identity, wallet, shared]`                     |
 * | `so.oxy.commons.dev`            | `[identity.dev, wallet.dev, shared]`             |
 * | `to.peable.app`                 | `[wallet, shared]`                               |
 * | `to.peable.app.dev`             | `[wallet.dev, shared]`                           |
 * | every other app                 | `[shared]`                                       |
 *
 * each optionally followed by the app's OWN application group,
 * `$(AppIdentifierPrefix)<its own bundle id>`, which Apple grants it anyway.
 * A holder may also still list `[shared]` alone: the build before its split,
 * which reads nothing secret. Nothing else, in particular no other bundle id:
 * `<TEAM>.<bundle id>` is each app's private group (ADR 0062 D6, its session
 * and its own items live there), and every app of the team may list any of the
 * team's groups, so an app naming another app's id reads that app's items.
 * The entitlement is native, so prebuild is the one place it can be stopped
 * before it ships; `oxy-check-keychain-entitlements` checks what a prebuild or
 * a codesign wrote, in CI and in every release build.
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

/** The spelling an allowed group must have: `$(AppIdentifierPrefix)<name>`, or `<teamId>.<name>`. */
function pinnedEntry(name, teamId) {
  return teamId === undefined ? `${PREFIX}${name}` : `${teamId}.${name}`;
}

/**
 * The lists this bundle id may ship, without its optional trailing own group:
 * its holder layout (or the shared group alone, before its split build), or
 * the shared group for every other app. An empty list is allowed too: it names
 * no group, like an app without the entitlement.
 * @param {string|undefined} bundleId
 * @returns {readonly (readonly string[])[]}
 */
function allowedKeychainLayouts(bundleId) {
  const layouts = [[], [G.shared]];
  if (Object.hasOwn(HOLDER_LAYOUTS, bundleId ?? '')) layouts.push(HOLDER_LAYOUTS[bundleId]);
  return layouts;
}

/**
 * Throw unless `entries` (a `keychain-access-groups` value) is one this bundle
 * id may ship: every entry judgeable and in its one spelling, each one of the
 * Oxy groups this bundle id holds or its own application group, and the whole
 * list exactly its layout (`allowedKeychainLayouts`), in order, optionally
 * followed by its own application group.
 *
 * @param {string|undefined} bundleId
 * @param {unknown} entries
 * @param {{ teamId?: string }} [options] `teamId`: the entries are BUILT
 *   (codesigned) entitlements of that team, so a group is spelled
 *   `<teamId>.<group>` instead of `$(AppIdentifierPrefix)<group>`.
 */
function assertOxyKeychainGroups(bundleId, entries, options = {}) {
  // An app's implicit own group must never alias a restricted shared group,
  // even when its entitlements omit keychain-access-groups altogether.
  if (typeof bundleId === 'string' && restrictedGroup(bundleId) !== undefined) {
    refuse(`${bundleId} is reserved for an Oxy restricted keychain group, not an app bundle id`);
  }
  if (entries === undefined || entries === null) return;
  const app = bundleId ?? 'This app';
  if (!Array.isArray(entries)) {
    refuse(`${app}: keychain-access-groups must be an array of strings`);
  }
  const { teamId } = options;
  if (teamId !== undefined && !TEAM_ID.test(teamId)) {
    refuse(`"${teamId}" is not an Apple team id (ten upper-case letters and digits)`);
  }
  const layout = keychainGroupsFor(bundleId);
  // The groups this app may name: its layout's, and its own application group.
  const own = typeof bundleId === 'string' && bundleId !== '' ? bundleId : undefined;
  const allowed = own === undefined ? [...layout] : [...layout, own];
  const allowedByName = new Map(allowed.map((name) => [name.toLowerCase(), name]));
  const ownHint =
    own === undefined ? '' : ` and, after them, its own application group "${PREFIX}${own}"`;

  /** The allowed group `entry` names, in its one spelling; throws for anything else. */
  const judge = (entry) => {
    if (typeof entry !== 'string') {
      refuse(`${app}: every keychain-access-groups entry must be a string`);
    }
    // The exact spelling first: a bundle id whose first label is ten
    // characters would otherwise be read as a team prefix below.
    const exact = allowed.find((name) => entry === pinnedEntry(name, teamId));
    if (exact !== undefined) return exact;

    const name = normalizeGroupName(entry);
    if (name === '' || /[$*?\s]/.test(name)) {
      refuse(
        `${app}: the keychain access group "${entry}" cannot be checked (a build variable, wildcard or ` +
          'whitespace past its team prefix). Name the group literally after $(AppIdentifierPrefix).',
      );
    }
    const canonical = allowedByName.get(name.toLowerCase());
    if (canonical !== undefined) {
      refuse(
        `${app} must spell the keychain access group "${entry}" exactly "${pinnedEntry(canonical, teamId)}"`,
      );
    }
    const restricted = restrictedGroup(name);
    if (restricted !== undefined) {
      refuse(
        `${app} may not list the keychain access group "${entry}" (${restricted}): only Commons holds ` +
          'the identity group and only Commons and the Peable wallet the wallet group, the production ' +
          'apps the production groups and their dev builds the .dev groups. Every other Oxy app lists ' +
          'group.so.oxy.shared',
      );
    }
    refuse(
      `${app} may not list the keychain access group "${entry}": it is not one of this app's groups ` +
        `[${layout.join(', ')}]${ownHint}. "<TEAM>.<bundle id>" is that app's own private group ` +
        "(ADR 0062 D6), so naming another app's bundle id, or any other group, lets this app read " +
        'items that are not its own',
    );
  };
  const names = [];
  for (const entry of entries) names.push(judge(entry));

  const base = own !== undefined && names.at(-1) === own ? names.slice(0, -1) : names;
  const fits = allowedKeychainLayouts(bundleId).some(
    (candidate) => candidate.join(',') === base.join(','),
  );
  if (!fits) {
    refuse(
      `${app} must list its keychain access groups as exactly [${layout.join(', ')}], in that order` +
        `${own === undefined ? '' : `, optionally followed by its own application group ${PREFIX}${own}`}` +
        ` (got [${names.join(', ')}]): the first entry is the default group, which decides where the ` +
        'identity is written and what @oxy.so/core lets this app read',
    );
  }
}

module.exports = {
  OXY_KEYCHAIN_GROUPS,
  HOLDER_LAYOUTS,
  allowedKeychainLayouts,
  assertOxyKeychainGroups,
  keychainEntries,
  keychainGroupsFor,
  normalizeGroupName,
  restrictedGroup,
};
