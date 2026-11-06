/**
 * The iOS keychain access-group policy (docs/identity/ios-keychain-access-groups.md):
 * only Commons may name the identity group, only Commons and the Peable wallet
 * the wallet group, each holder's groups lead its list in its order, and every
 * other app keeps the shared group as its default.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const withOxyKeychain = require('../plugin/withOxyKeychain');
const { withOxyKeychainPolicy } = withOxyKeychain;
const { assertOxyKeychainGroups, HOLDER_LAYOUTS } = require('../plugin/oxyKeychainGroups');

const P = '$(AppIdentifierPrefix)';
const SHARED = `${P}group.so.oxy.shared`;
const WALLET = `${P}so.oxy.wallet`;
const IDENTITY = `${P}so.oxy.identity`;

/** Run the entitlements mod a plugin registered, over `existing`. */
async function entitlementsAfter(config, existing = {}) {
  const mod = config.mods?.ios?.entitlements;
  assert.equal(typeof mod, 'function', 'an iOS entitlements mod is registered');
  const result = await mod({
    ...config,
    modResults: { ...existing },
    modRequest: { platform: 'ios', modName: 'entitlements', projectRoot: '/tmp' },
  });
  return result.modResults['keychain-access-groups'];
}

const app = (bundleIdentifier, entitlements) => ({
  name: 'app',
  ios: { bundleIdentifier, ...(entitlements ? { entitlements } : {}) },
});

test('every app but the two holders gets the shared group, and only it', async () => {
  for (const id of ['so.oxy.mention', 'so.oxy.accounts', 'to.peable.orbit', undefined]) {
    assert.deepEqual(await entitlementsAfter(withOxyKeychain(app(id))), [SHARED]);
  }
});

test('Commons lists identity, wallet, shared — identity FIRST, ahead of anything declared', async () => {
  for (const id of ['so.oxy.commons', 'so.oxy.commons.dev']) {
    const groups = await entitlementsAfter(withOxyKeychain(app(id)), {
      'keychain-access-groups': [SHARED, `${P}com.example.other`],
    });
    assert.deepEqual(groups, [IDENTITY, WALLET, SHARED, `${P}com.example.other`]);
  }
});

test('the Peable wallet lists wallet, shared — wallet first', async () => {
  for (const id of ['to.peable.app', 'to.peable.app.dev']) {
    assert.deepEqual(await entitlementsAfter(withOxyKeychain(app(id))), [WALLET, SHARED]);
  }
});

test('no other app may name the identity or the wallet group', async () => {
  for (const group of ['so.oxy.identity', 'so.oxy.wallet']) {
    assert.throws(
      () => withOxyKeychain(app('so.oxy.mention'), [group, 'group.so.oxy.shared']),
      /may not list/,
    );
    // Declared straight in the app config, past the preset: the policy that
    // withOxyUpdates (every Oxy app) applies catches it too.
    assert.throws(
      () =>
        withOxyKeychainPolicy(
          app('to.peable.orbit', { 'keychain-access-groups': [`${P}${group}`] }),
        ),
      /may not list/,
    );
  }
  assert.throws(() => withOxyKeychain(app('to.peable.app'), ['so.oxy.identity']), /may not list/);
});

test('a holder that puts another group first is refused (the first entry is the default group)', () => {
  assert.throws(
    () =>
      withOxyKeychainPolicy(
        app('so.oxy.commons', { 'keychain-access-groups': [SHARED, IDENTITY, WALLET] }),
      ),
    /must list its keychain access groups/,
  );
  assert.throws(
    () =>
      withOxyKeychainPolicy(
        app('so.oxy.commons', { 'keychain-access-groups': [WALLET, IDENTITY, SHARED] }),
      ),
    /must list its keychain access groups/,
  );
  assert.throws(
    () =>
      withOxyKeychainPolicy(app('to.peable.app', { 'keychain-access-groups': [SHARED, WALLET] })),
    /must list its keychain access groups/,
  );
  // A holder still on the shared group alone (before its new build) is fine.
  assert.doesNotThrow(() => assertOxyKeychainGroups('to.peable.app', [SHARED]));
});

test('the holders are exactly Commons and the Peable wallet', () => {
  assert.deepEqual(Object.keys(HOLDER_LAYOUTS).sort(), [
    'so.oxy.commons',
    'so.oxy.commons.dev',
    'to.peable.app',
    'to.peable.app.dev',
  ]);
});

// The app configs in this repository, read as text so no app's build-time
// dependencies are needed: only Commons may mention a restricted group, and it
// lists them in its order.
test('no app config in this repository but Commons names a restricted group', () => {
  const packages = resolve(__dirname, '../..');
  for (const dir of readdirSync(packages)) {
    for (const file of ['app.config.js', 'app.config.ts', 'app.json']) {
      const path = join(packages, dir, file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const named = /so\.oxy\.(identity|wallet)\b/.test(text);
      if (dir === 'commons') {
        assert.ok(
          text.includes(
            `'keychain-access-groups': [\n          '${IDENTITY}',\n          '${WALLET}',\n          '${SHARED}',\n        ]`,
          ),
          'Commons lists identity, wallet, shared in that order',
        );
      } else {
        assert.equal(named, false, `${dir}/${file} names a restricted keychain group`);
      }
    }
  }
});
