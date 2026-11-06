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
const {
  assertOxyKeychainGroups,
  HOLDER_LAYOUTS,
  OXY_KEYCHAIN_GROUPS,
  keychainEntries,
  keychainGroupsFor,
  normalizeGroupName,
} = require('../plugin/oxyKeychainGroups');

const P = '$(AppIdentifierPrefix)';
const SHARED = `${P}group.so.oxy.shared`;
const WALLET = `${P}so.oxy.wallet`;
const IDENTITY = `${P}so.oxy.identity`;
const WALLET_DEV = `${P}so.oxy.wallet.dev`;
const IDENTITY_DEV = `${P}so.oxy.identity.dev`;

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
  const groups = await entitlementsAfter(withOxyKeychain(app('so.oxy.commons')), {
    'keychain-access-groups': [SHARED, `${P}com.example.other`],
  });
  assert.deepEqual(groups, [IDENTITY, WALLET, SHARED, `${P}com.example.other`]);
});

test('the Peable wallet lists wallet, shared — wallet first', async () => {
  assert.deepEqual(await entitlementsAfter(withOxyKeychain(app('to.peable.app'))), [
    WALLET,
    SHARED,
  ]);
});

test('the dev builds get the .dev restricted groups, never the production ones', async () => {
  assert.deepEqual(await entitlementsAfter(withOxyKeychain(app('so.oxy.commons.dev'))), [
    IDENTITY_DEV,
    WALLET_DEV,
    SHARED,
  ]);
  assert.deepEqual(await entitlementsAfter(withOxyKeychain(app('to.peable.app.dev'))), [
    WALLET_DEV,
    SHARED,
  ]);
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

test('the holders are exactly Commons and the Peable wallet, each variant with its own groups', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(HOLDER_LAYOUTS).map(([id, layout]) => [id, [...layout]])),
    {
      'so.oxy.commons': ['so.oxy.identity', 'so.oxy.wallet', 'group.so.oxy.shared'],
      'so.oxy.commons.dev': ['so.oxy.identity.dev', 'so.oxy.wallet.dev', 'group.so.oxy.shared'],
      'to.peable.app': ['so.oxy.wallet', 'group.so.oxy.shared'],
      'to.peable.app.dev': ['so.oxy.wallet.dev', 'group.so.oxy.shared'],
    },
  );
  assert.equal(OXY_KEYCHAIN_GROUPS.identityDev, 'so.oxy.identity.dev');
  assert.equal(OXY_KEYCHAIN_GROUPS.walletDev, 'so.oxy.wallet.dev');
});

test('a dev build may not name a production restricted group, nor a production app a .dev one', () => {
  const cases = [
    ['so.oxy.commons.dev', [IDENTITY, WALLET, SHARED]],
    ['so.oxy.commons.dev', [IDENTITY_DEV, WALLET, SHARED]],
    ['to.peable.app.dev', [WALLET, SHARED]],
    ['so.oxy.commons', [IDENTITY_DEV, WALLET_DEV, SHARED]],
    ['so.oxy.commons', [IDENTITY, WALLET, SHARED, WALLET_DEV]],
    ['to.peable.app', [WALLET_DEV, SHARED]],
    // The wallet's dev build is not Commons' dev build.
    ['to.peable.app.dev', [IDENTITY_DEV, WALLET_DEV, SHARED]],
    ['so.oxy.mention', [IDENTITY_DEV]],
    ['so.oxy.mention.dev', [WALLET_DEV, SHARED]],
  ];
  for (const [id, groups] of cases) {
    assert.throws(() => assertOxyKeychainGroups(id, groups), /may not list/, `${id} ${groups}`);
  }
  assert.throws(
    () => withOxyKeychain(app('so.oxy.commons.dev'), ['so.oxy.identity']),
    /may not list/,
  );
});

// Every spelling below names a restricted group once Xcode expands it (or once
// the team id is read as a prefix). The policy judged only the
// `$(AppIdentifierPrefix)` spelling before 6.3.0, so each of these passed.
const BYPASS_SPELLINGS = (group) => [
  `ABCDE12345.${group}`,
  `abcde12345.${group}`,
  `$(TeamIdentifierPrefix)${group}`,
  `\${AppIdentifierPrefix}${group}`,
  `\${TeamIdentifierPrefix}${group}`,
  `$(AppIdentifierPrefix:rfc1034identifier)${group}`,
  `$(AppIdentifierPrefix)$(TeamIdentifierPrefix)${group}`,
  `$(AppIdentifierPrefix)ABCDE12345.${group}`,
  `$(AppIdentifierPrefix$(NESTED))${group}`,
  ` $(AppIdentifierPrefix)${group}`,
  `$(AppIdentifierPrefix)${group} `,
  `$(AppIdentifierPrefix) ${group}`,
  `$(AppIdentifierPrefix)\t${group}\n`,
  `$(AppIdentifierPrefix)${group.toUpperCase()}`,
  `$(TeamIdentifierPrefix)${group.replace('oxy', 'OXY')}`,
  group,
];
const RESTRICTED_GROUPS = [
  'so.oxy.identity',
  'so.oxy.wallet',
  'so.oxy.identity.dev',
  'so.oxy.wallet.dev',
];

test('every other spelling of a restricted group is refused for an app that is not its holder', () => {
  for (const group of RESTRICTED_GROUPS) {
    for (const entry of BYPASS_SPELLINGS(group)) {
      for (const id of ['so.oxy.mention', 'to.peable.orbit', undefined]) {
        assert.throws(
          () => assertOxyKeychainGroups(id, [SHARED, entry]),
          /may not list/,
          `${id} ${JSON.stringify(entry)}`,
        );
      }
      assert.throws(
        () =>
          withOxyKeychainPolicy(
            app('so.oxy.mention', { 'keychain-access-groups': [entry, SHARED] }),
          ),
        /may not list/,
        JSON.stringify(entry),
      );
    }
  }
});

test('a holder must spell its restricted groups exactly $(AppIdentifierPrefix)<group>', () => {
  const holders = {
    'so.oxy.commons': ['so.oxy.identity', 'so.oxy.wallet'],
    'so.oxy.commons.dev': ['so.oxy.identity.dev', 'so.oxy.wallet.dev'],
    'to.peable.app': ['so.oxy.wallet'],
    'to.peable.app.dev': ['so.oxy.wallet.dev'],
  };
  for (const [id, groups] of Object.entries(holders)) {
    const layout = keychainEntries(keychainGroupsFor(id));
    assert.doesNotThrow(() => assertOxyKeychainGroups(id, layout));
    for (const group of groups) {
      for (const entry of BYPASS_SPELLINGS(group)) {
        const misspelled = layout.map((e) => (e === `${P}${group}` ? entry : e));
        assert.throws(
          () => assertOxyKeychainGroups(id, misspelled),
          /must spell the keychain access group/,
          `${id} ${JSON.stringify(entry)}`,
        );
        // Also as an extra entry next to the right spelling.
        assert.throws(
          () => assertOxyKeychainGroups(id, [...layout, entry]),
          /must spell the keychain access group/,
          `${id} extra ${JSON.stringify(entry)}`,
        );
      }
    }
  }
});

test('an entry that cannot be judged is refused, for every app', () => {
  const unjudgeable = [
    `${P}$(PRODUCT_BUNDLE_IDENTIFIER)`,
    `${P}so.oxy.$(GROUP)`,
    '$(KEYCHAIN_GROUP)',
    `${P}*`,
    'ABCDE12345.*',
    `${P}so.oxy.*`,
    `${P}so.oxy.ident?ty`,
    `${P}so.oxy. identity`,
    '$(AppIdentifierPrefix so.oxy.identity',
    `$VAR${'so.oxy.identity'}`,
    '',
    '   ',
    P,
  ];
  for (const entry of unjudgeable) {
    for (const id of ['so.oxy.mention', 'so.oxy.commons']) {
      assert.throws(
        () => assertOxyKeychainGroups(id, [SHARED, entry]),
        /cannot be checked/,
        `${id} ${JSON.stringify(entry)}`,
      );
    }
  }
  assert.throws(() => assertOxyKeychainGroups('so.oxy.mention', [SHARED, 42]), /must be a string/);
  assert.throws(() => assertOxyKeychainGroups('so.oxy.mention', IDENTITY), /must be an array/);
  assert.doesNotThrow(() => assertOxyKeychainGroups('so.oxy.mention', undefined));
});

test('ordinary groups keep working in any spelling', () => {
  for (const entry of [
    SHARED,
    `$(TeamIdentifierPrefix)group.so.oxy.shared`,
    'ABCDE12345.group.so.oxy.shared',
    `${P}com.example.other`,
    `${P}so.oxy.identityx`,
    `${P}group.so.oxy.identity`,
  ]) {
    assert.doesNotThrow(() => assertOxyKeychainGroups('so.oxy.mention', [SHARED, entry]), entry);
  }
});

test('the preset keeps a misspelled restricted group another plugin wrote, so the check refuses it', async () => {
  const config = withOxyKeychain(app('so.oxy.commons'));
  await assert.rejects(
    entitlementsAfter(config, {
      'keychain-access-groups': [SHARED, '$(TeamIdentifierPrefix)so.oxy.identity'],
    }),
    /must spell the keychain access group/,
  );
  await assert.rejects(
    entitlementsAfter(withOxyKeychain(app('so.oxy.mention')), {
      'keychain-access-groups': ['ABCDE12345.so.oxy.wallet'],
    }),
    /may not list/,
  );
  // A respelled ORDINARY duplicate of a wanted group is folded into it.
  assert.deepEqual(
    await entitlementsAfter(withOxyKeychain(app('so.oxy.mention')), {
      'keychain-access-groups': ['$(TeamIdentifierPrefix)group.so.oxy.shared'],
    }),
    [SHARED],
  );
});

test('built entitlements are checked against the team id they were expanded with', () => {
  const built = [
    'ABCDE12345.so.oxy.identity',
    'ABCDE12345.so.oxy.wallet',
    'ABCDE12345.group.so.oxy.shared',
  ];
  assert.doesNotThrow(() =>
    assertOxyKeychainGroups('so.oxy.commons', built, { teamId: 'ABCDE12345' }),
  );
  assert.throws(
    () => assertOxyKeychainGroups('so.oxy.commons', built, { teamId: 'ZZZZZ99999' }),
    /must spell/,
  );
  assert.throws(
    () => assertOxyKeychainGroups('so.oxy.mention', built, { teamId: 'ABCDE12345' }),
    /may not list/,
  );
  assert.throws(
    () =>
      assertOxyKeychainGroups('so.oxy.commons', keychainEntries(['so.oxy.identity']), {
        teamId: 'ABCDE12345',
      }),
    /must spell/,
  );
  assert.throws(
    () => assertOxyKeychainGroups('so.oxy.commons', built, { teamId: 'abc' }),
    /not an Apple team id/,
  );
});

test('normalizeGroupName strips every team-prefix spelling and nothing else', () => {
  assert.equal(
    normalizeGroupName(` $(AppIdentifierPrefix)\${X}ABCDE12345.so.oxy.wallet `),
    'so.oxy.wallet',
  );
  assert.equal(normalizeGroupName('group.so.oxy.shared'), 'group.so.oxy.shared');
  assert.equal(normalizeGroupName('$(Unclosed so.oxy.wallet'), '$(Unclosed so.oxy.wallet');
});

/**
 * Commons' app.config.js, evaluated for a variant. Its only build-time
 * dependency outside this repository's plain CommonJS is the splash plugin
 * factory, which is stubbed: only `ios` is read here.
 */
function loadCommonsConfig(variant) {
  const path = resolve(__dirname, '../../commons/app.config.js');
  const Module = require('node:module');
  const load = Module._load;
  const previous = { APP_VARIANT: process.env.APP_VARIANT, warn: console.warn };
  Module._load = function stubbed(request, ...rest) {
    if (request === '@oxy.so/expo-splash/config') return { oxySplashScreenPlugin: () => 'splash' };
    return load.call(this, request, ...rest);
  };
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  console.warn = () => {};
  try {
    delete require.cache[path];
    return require(path).expo;
  } finally {
    Module._load = load;
    console.warn = previous.warn;
    if (previous.APP_VARIANT === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previous.APP_VARIANT;
    delete require.cache[path];
  }
}

test('Commons lists its own variant’s groups, in order, and the policy accepts them', () => {
  for (const [variant, id] of [
    [undefined, 'so.oxy.commons'],
    ['development', 'so.oxy.commons.dev'],
  ]) {
    const expo = loadCommonsConfig(variant);
    assert.equal(expo.ios.bundleIdentifier, id);
    const groups = expo.ios.entitlements['keychain-access-groups'];
    assert.deepEqual(groups, keychainEntries(keychainGroupsFor(id)));
    assert.doesNotThrow(() => withOxyKeychainPolicy(expo));
  }
});

// The app configs in this repository, read as text so no app's build-time
// dependencies are needed: only Commons may mention a restricted group.
test('no app config in this repository but Commons names a restricted group', () => {
  const packages = resolve(__dirname, '../..');
  for (const dir of readdirSync(packages)) {
    if (dir === 'commons') continue;
    for (const file of ['app.config.js', 'app.config.ts', 'app.json']) {
      const path = join(packages, dir, file);
      if (!existsSync(path)) continue;
      const named = /so\.oxy\.(identity|wallet)\b/i.test(readFileSync(path, 'utf8'));
      assert.equal(named, false, `${dir}/${file} names a restricted keychain group`);
    }
  }
});
