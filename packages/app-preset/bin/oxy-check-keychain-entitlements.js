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
 * `<path>` may also be a SIGNED build (security review R6-15): an `.app`, an
 * `.xcarchive` or an `.ipa`. Then what is checked is what the binary will
 * actually run with: `codesign -d --entitlements - --xml` (macOS) over the
 * app and every extension it embeds (`PlugIns/*.appex`, `Extensions/*.appex`).
 * Each bundle's id and team come from its OWN signed `application-identifier`
 * and `com.apple.developer.team-identifier`, never from the command line; the
 * app's id must be `<bundle-id>` (compared without case, as Apple does), and
 * each extension is judged under its own id. Run it on every archive before it
 * is uploaded (docs/engineering/build-and-deploy.md).
 *
 * Exits 0 when every file passes, 1 on a policy violation, 2 on a usage or
 * read error. A directory with no entitlements file is an error: there was
 * nothing to check.
 */
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
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

/** The entitlements dictionary of a plist text, or a UsageError naming `source`. */
function parseEntitlements(text, source, plist) {
  let parsed;
  try {
    parsed = plist.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not a readable plist: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${source} carries no entitlements dictionary`);
  }
  return parsed;
}

const SIGNED_BUNDLE = /\.(app|xcarchive|ipa)$/i;

/** `codesign -d --entitlements - --xml <bundle>`: the entitlements a signed bundle runs with (macOS). */
function codesignEntitlements(bundle) {
  try {
    return execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', bundle], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new UsageError(
      `codesign could not read the entitlements of ${bundle} (macOS only): ${error.message}`,
    );
  }
}

/** The `.app` directories directly in `dir`. */
function appsIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => join(dir, entry.name));
}

/** The app of a signed build, and every extension it embeds. */
function signedBundles(app) {
  const extensions = ['PlugIns', 'Extensions'].flatMap((folder) => {
    try {
      return readdirSync(join(app, folder), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.appex'))
        .map((entry) => join(app, folder, entry.name));
    } catch {
      return [];
    }
  });
  return [app, ...extensions.sort()];
}

/**
 * Check a SIGNED `.app`, `.xcarchive` or `.ipa` (R6-15): the entitlements
 * codesign reports for the app and each embedded extension, each bundle judged
 * under the id and team its own signature names.
 *
 * @param {{ bundleId: string, target: string, plist: { parse(text: string): unknown },
 *   codesign?: (bundle: string) => string, unzip?: (ipa: string, into: string) => void }} options
 */
function checkSignedBuild({ bundleId, target, plist, codesign = codesignEntitlements, unzip }) {
  let scratch;
  try {
    let apps;
    if (/\.ipa$/i.test(target)) {
      scratch = mkdtempSync(join(tmpdir(), 'oxy-ipa-'));
      (
        unzip ??
        ((ipa, into) => execFileSync('unzip', ['-q', ipa, '-d', into], { stdio: 'ignore' }))
      )(target, scratch);
      apps = appsIn(join(scratch, 'Payload'));
    } else if (/\.xcarchive$/i.test(target)) {
      apps = appsIn(join(target, 'Products', 'Applications'));
    } else {
      apps = [target];
    }
    if (apps.length !== 1) {
      throw new UsageError(`${target} must hold exactly one .app (found ${apps.length})`);
    }
    return signedBundles(apps[0]).map((bundle, index) => {
      const source = `${basename(target)}:${bundle === apps[0] ? basename(bundle) : bundle.slice(apps[0].length + 1)}`;
      const entitlements = parseEntitlements(codesign(bundle), source, plist);
      const teamId = entitlements['com.apple.developer.team-identifier'];
      const appId = entitlements['application-identifier'];
      if (
        typeof teamId !== 'string' ||
        typeof appId !== 'string' ||
        !appId.startsWith(`${teamId}.`)
      ) {
        throw new UsageError(
          `${source}: no signed application-identifier and team-identifier (is it signed?)`,
        );
      }
      const signedId = appId.slice(teamId.length + 1);
      if (index === 0 && signedId.toLowerCase() !== bundleId.toLowerCase()) {
        throw new Error(`${source}: is signed as ${signedId}, not ${bundleId}`);
      }
      try {
        assertOxyKeychainGroups(signedId, entitlements[KEY], { teamId });
      } catch (error) {
        error.message = `${source}: ${error.message}`;
        throw error;
      }
      return { file: source, groups: entitlements[KEY] };
    });
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Check `target` for `bundleId`. Throws the policy's Error on a violation and
 * a UsageError when there is nothing readable to check.
 *
 * @param {{ bundleId: string, target: string, teamId?: string, plist?: { parse(text: string): unknown } }} options
 * @returns {{ file: string, groups: unknown }[]}
 */
function checkKeychainEntitlements({ bundleId, target, teamId, plist, codesign, unzip }) {
  const path = resolve(target);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new UsageError(`${target} does not exist`);
  }
  if (SIGNED_BUNDLE.test(path)) {
    if (teamId !== undefined) {
      throw new UsageError('--team-id is read from the signature of a signed build; drop it');
    }
    return checkSignedBuild({
      bundleId,
      target: path,
      plist: plist ?? loadPlist(),
      codesign,
      unzip,
    });
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
      'usage: oxy-check-keychain-entitlements <bundle-id> <entitlements-file-or-ios-dir> [--team-id <TEAMID>]\n' +
        '       oxy-check-keychain-entitlements <bundle-id> <signed .app | .xcarchive | .ipa>',
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
  checkSignedBuild,
  findEntitlements,
  main,
  readKeychainGroups,
  UsageError,
};

if (require.main === module) {
  process.exitCode = main();
}
