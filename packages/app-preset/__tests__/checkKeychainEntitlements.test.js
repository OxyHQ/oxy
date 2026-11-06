/**
 * `oxy-check-keychain-entitlements`: the keychain access-group policy over the
 * entitlements a prebuild (or a codesign) actually wrote.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const BIN = resolve(__dirname, '../bin/oxy-check-keychain-entitlements.js');
const { checkKeychainEntitlements, main, UsageError } = require(BIN);
const packageJson = require('../package.json');

const P = '$(AppIdentifierPrefix)';

function escapeXml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function entitlementsXml(groups) {
  const array =
    groups === undefined
      ? ''
      : `<key>keychain-access-groups</key><array>${groups
          .map((group) => `<string>${escapeXml(group)}</string>`)
          .join('')}</array>`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0"><dict><key>aps-environment</key><string>production</string>${array}</dict></plist>\n`
  );
}

/** A throwaway prebuild-like `ios/` with one app's entitlements. */
function iosDir(groups, { app = 'App', pods } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oxy-keychain-'));
  const ios = join(root, 'ios');
  mkdirSync(join(ios, app), { recursive: true });
  writeFileSync(join(ios, app, `${app}.entitlements`), entitlementsXml(groups));
  if (pods) {
    mkdirSync(join(ios, 'Pods', 'Lib'), { recursive: true });
    writeFileSync(join(ios, 'Pods', 'Lib', 'Lib.entitlements'), entitlementsXml(pods));
  }
  return { root, ios, file: join(ios, app, `${app}.entitlements`) };
}

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('the package ships the checker as a bin and an export', () => {
  assert.equal(
    packageJson.bin['oxy-check-keychain-entitlements'],
    './bin/oxy-check-keychain-entitlements.js',
  );
  assert.equal(
    packageJson.exports['./check-entitlements'],
    './bin/oxy-check-keychain-entitlements.js',
  );
  assert.ok(packageJson.files.includes('bin'));
});

test('a prebuild ios/ directory that follows the policy passes', () => {
  const commons = iosDir([`${P}so.oxy.identity`, `${P}so.oxy.wallet`, `${P}group.so.oxy.shared`]);
  const mention = iosDir([`${P}group.so.oxy.shared`]);
  try {
    assert.equal(run(['so.oxy.commons', commons.ios]).code, 0);
    assert.equal(run(['so.oxy.mention', mention.ios]).code, 0);
    assert.equal(run(['so.oxy.mention', mention.file]).code, 0);
  } finally {
    rmSync(commons.root, { recursive: true, force: true });
    rmSync(mention.root, { recursive: true, force: true });
  }
});

test('a violation exits 1 and names the file', () => {
  const cases = [
    ['so.oxy.mention', [`${P}group.so.oxy.shared`, `${P}so.oxy.identity`]],
    ['so.oxy.mention', ['$(TeamIdentifierPrefix)so.oxy.wallet']],
    ['so.oxy.mention', ['ABCDE12345.so.oxy.identity']],
    ['so.oxy.commons', ['$(TeamIdentifierPrefix)so.oxy.identity', `${P}so.oxy.wallet`]],
    ['so.oxy.commons.dev', [`${P}so.oxy.identity`, `${P}so.oxy.wallet`, `${P}group.so.oxy.shared`]],
    ['to.peable.app.dev', [`${P}so.oxy.wallet`, `${P}group.so.oxy.shared`]],
    ['so.oxy.commons', [`${P}group.so.oxy.shared`, `${P}so.oxy.identity`, `${P}so.oxy.wallet`]],
    ['so.oxy.mention', [`${P}*`]],
    // R5-4: another app's own application group, which is that app's private group.
    ['so.oxy.mention', [`${P}group.so.oxy.shared`, `${P}to.peable.app`]],
    ['so.oxy.mention', [`${P}group.so.oxy.shared`, `${P}so.oxy.commons`]],
    ['so.oxy.mention', [`${P}group.so.oxy.shared`, 'to.peable.app.dev']],
  ];
  for (const [id, groups] of cases) {
    const dir = iosDir(groups);
    try {
      const result = run([id, dir.ios]);
      assert.equal(result.code, 1, `${id} ${JSON.stringify(groups)}`);
      assert.ok(result.err.includes(dir.file), result.err);
    } finally {
      rmSync(dir.root, { recursive: true, force: true });
    }
  }
});

test('Pods are skipped; every app entitlements file is checked', () => {
  const dir = iosDir([`${P}group.so.oxy.shared`], { pods: [`${P}so.oxy.identity`] });
  try {
    assert.equal(run(['so.oxy.mention', dir.ios]).code, 0);
    mkdirSync(join(dir.ios, 'Extension'));
    writeFileSync(
      join(dir.ios, 'Extension', 'Extension.entitlements'),
      entitlementsXml([`${P}so.oxy.wallet`]),
    );
    assert.equal(run(['so.oxy.mention', dir.ios]).code, 1);
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test('built (codesigned) entitlements are checked with --team-id', () => {
  const built = ['ABCDE12345.so.oxy.wallet', 'ABCDE12345.group.so.oxy.shared'];
  const dir = iosDir(built);
  try {
    assert.equal(run(['to.peable.app', dir.file, '--team-id', 'ABCDE12345']).code, 0);
    assert.equal(run(['to.peable.app', dir.file, '--team-id=ABCDE12345']).code, 0);
    assert.equal(run(['to.peable.app', dir.file]).code, 1);
    assert.equal(run(['to.peable.app', dir.file, '--team-id', 'ZZZZZ99999']).code, 1);
    assert.equal(run(['to.peable.app.dev', dir.file, '--team-id', 'ABCDE12345']).code, 1);
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test('nothing to check, or nothing readable, exits 2', () => {
  const empty = mkdtempSync(join(tmpdir(), 'oxy-keychain-'));
  const binary = join(empty, 'binary.entitlements');
  const junk = join(empty, 'junk.xcent');
  writeFileSync(binary, 'bplist00\u0000\u0001');
  writeFileSync(junk, 'not a plist');
  try {
    // The directory holds one *.entitlements, and it is binary.
    assert.equal(run(['so.oxy.mention', empty]).code, 2);
    assert.equal(run(['so.oxy.mention', binary]).code, 2);
    assert.match(run(['so.oxy.mention', binary]).err, /binary plist/);
    assert.equal(run(['so.oxy.mention', junk]).code, 2);
    assert.equal(run(['so.oxy.mention', join(empty, 'missing')]).code, 2);
    assert.equal(run(['so.oxy.mention']).code, 2);
    assert.equal(run(['so.oxy.mention', empty, '--team-id']).code, 2);
    assert.equal(run(['so.oxy.mention', empty, '--unknown']).code, 2);
    const nothing = mkdtempSync(join(tmpdir(), 'oxy-keychain-'));
    try {
      assert.throws(
        () => checkKeychainEntitlements({ bundleId: 'x', target: nothing }),
        UsageError,
      );
    } finally {
      rmSync(nothing, { recursive: true, force: true });
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a file with no keychain-access-groups passes (it can read no group); a non-array fails', () => {
  const dir = iosDir(undefined);
  try {
    assert.equal(run(['so.oxy.mention', dir.ios]).code, 0);
    writeFileSync(
      dir.file,
      entitlementsXml([]).replace(
        '<key>keychain-access-groups</key><array></array>',
        `<key>keychain-access-groups</key><string>${P}so.oxy.identity</string>`,
      ),
    );
    assert.equal(run(['so.oxy.mention', dir.ios]).code, 1);
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});

test('the bin runs as a process and exits non-zero on a violation', () => {
  const dir = iosDir([`${P}so.oxy.identity`]);
  try {
    const refused = spawnSync(process.execPath, [BIN, 'so.oxy.mention', dir.ios], {
      encoding: 'utf8',
      cwd: resolve(__dirname, '..'),
    });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /may not list/);
    const commons = spawnSync(process.execPath, [BIN, 'so.oxy.commons', dir.ios], {
      encoding: 'utf8',
      cwd: resolve(__dirname, '..'),
    });
    // Commons listing only the identity group breaks its layout.
    assert.equal(commons.status, 1, commons.stderr);
    assert.match(commons.stderr, /must list its keychain access groups/);
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
});
