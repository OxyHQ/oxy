#!/usr/bin/env node
/**
 * oxy-check-keychain-entitlements — the keychain access-group policy
 * (`plugin/oxyKeychainGroups.js`) run over entitlements that were actually
 * WRITTEN, not over an app config: what `expo prebuild` left in `ios/`, or what
 * a signed binary carries.
 *
 *   oxy-check-keychain-entitlements <bundle-id> <path> [--team-id <TEAMID>]
 *
 * `<path>` is an entitlements plist (`.entitlements`, `.xcent`, the XML of
 * `codesign -d --entitlements - --xml <app>`) or a directory searched for
 * `*.entitlements` (an `ios/` folder after prebuild; `Pods`, `build` and
 * `node_modules` are skipped). Every file found is checked. `--team-id` says
 * the file is codesigned output of that team, whose entries are expanded
 * (`<TEAMID>.so.oxy.wallet`, not `$(AppIdentifierPrefix)so.oxy.wallet`).
 *
 * Exits 0 when every file passes, 1 on a policy violation, 2 on a usage or
 * read error. A directory with no entitlements file is an error: there was
 * nothing to check.
 */
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { assertOxyKeychainGroups } = require('../plugin/oxyKeychainGroups');

const KEY = 'keychain-access-groups';
const SKIPPED_DIRS = new Set(['Pods', 'build', 'node_modules', 'DerivedData']);

class UsageError extends Error {}

/** `@expo/plist`, from the app first, then through Expo's own config plugins. */
function loadPlist(projectRoot = process.cwd()) {
  const attempts = [
    () => require.resolve('@expo/plist', { paths: [projectRoot] }),
    () =>
      require.resolve('@expo/plist', {
        paths: [require.resolve('expo/config-plugins', { paths: [projectRoot] })],
      }),
    () => require.resolve('@expo/plist', { paths: [require.resolve('expo/config-plugins')] }),
    () => require.resolve('@expo/plist'),
  ];
  for (const attempt of attempts) {
    try {
      const plist = require(attempt());
      return plist.default ?? plist;
    } catch {
      // Try the next resolution.
    }
  }
  throw new UsageError(
    '@expo/plist could not be loaded: run this from an Expo app (expo installs it)',
  );
}

/** The `keychain-access-groups` value of one entitlements plist. */
function readKeychainGroups(file, plist = loadPlist()) {
  const text = readFileSync(file, 'utf8');
  if (text.startsWith('bplist')) {
    throw new UsageError(`${file} is a binary plist: convert it with \`plutil -convert xml1\``);
  }
  let parsed;
  try {
    parsed = plist.parse(text);
  } catch (error) {
    throw new UsageError(`${file} is not a readable plist: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${file} is not an entitlements dictionary`);
  }
  return parsed[KEY];
}

/** Every `*.entitlements` under `dir`, sorted. */
function findEntitlements(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.entitlements')) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * Check `target` for `bundleId`. Throws the policy's Error on a violation and
 * a UsageError when there is nothing readable to check.
 *
 * @param {{ bundleId: string, target: string, teamId?: string, plist?: { parse(text: string): unknown } }} options
 * @returns {{ file: string, groups: unknown }[]}
 */
function checkKeychainEntitlements({ bundleId, target, teamId, plist }) {
  const path = resolve(target);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new UsageError(`${target} does not exist`);
  }
  const files = stats.isDirectory() ? findEntitlements(path) : [path];
  if (files.length === 0) {
    throw new UsageError(`no *.entitlements file under ${target}`);
  }
  const parser = plist ?? loadPlist();
  return files.map((file) => {
    const groups = readKeychainGroups(file, parser);
    try {
      assertOxyKeychainGroups(bundleId, groups, teamId === undefined ? {} : { teamId });
    } catch (error) {
      error.message = `${file}: ${error.message}`;
      throw error;
    }
    return { file, groups };
  });
}

function parseArgs(argv) {
  const positional = [];
  let teamId;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--team-id') {
      teamId = argv[i + 1];
      if (teamId === undefined) throw new UsageError('--team-id needs a value');
      i += 1;
    } else if (arg.startsWith('--team-id=')) {
      teamId = arg.slice('--team-id='.length);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new UsageError(
      'usage: oxy-check-keychain-entitlements <bundle-id> <entitlements-file-or-ios-dir> [--team-id <TEAMID>]',
    );
  }
  return { bundleId: positional[0], target: positional[1], teamId };
}

/** The CLI. Returns the exit code. */
function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  try {
    const results = checkKeychainEntitlements(parseArgs(argv));
    for (const { file, groups } of results) {
      log(`ok ${file}: ${JSON.stringify(groups ?? [])}`);
    }
    return 0;
  } catch (failure) {
    error(failure.message);
    return failure instanceof UsageError ? 2 : 1;
  }
}

module.exports = {
  checkKeychainEntitlements,
  findEntitlements,
  main,
  readKeychainGroups,
  UsageError,
};

if (require.main === module) {
  process.exitCode = main();
}
