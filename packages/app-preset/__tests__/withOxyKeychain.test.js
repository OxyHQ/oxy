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
  assert.deepEqual(
    await entitlementsAfter(withOxyKeychain(app('so.oxy.commons')), {
      'keychain-access-groups': [SHARED],
    }),
    [IDENTITY, WALLET, SHARED],
  );
  // Its own application group, declared by the app, stays after the layout.
  assert.deepEqual(
    await entitlementsAfter(withOxyKeychain(app('so.oxy.commons')), {
      'keychain-access-groups': [`${P}so.oxy.commons`, SHARED],
    }),
    [IDENTITY, WALLET, SHARED, `${P}so.oxy.commons`],
  );
  // Any other group another plugin declared fails prebuild instead of being kept.
  await assert.rejects(
    entitlementsAfter(withOxyKeychain(app('so.oxy.commons')), {
      'keychain-access-groups': [SHARED, `${P}com.example.other`],
    }),
    /may not list the keychain access group "\$\(AppIdentifierPrefix\)com\.example\.other": it is not one of/,
  );
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

test('the shared group and the own application group must be spelled exactly', () => {
  for (const entry of [
    `$(TeamIdentifierPrefix)group.so.oxy.shared`,
    'ABCDE12345.group.so.oxy.shared',
    `${P}GROUP.so.oxy.shared`,
    ` ${SHARED}`,
  ]) {
    assert.throws(
      () => assertOxyKeychainGroups('so.oxy.mention', [entry]),
      /must spell the keychain access group/,
      entry,
    );
  }
  for (const entry of [
    '$(TeamIdentifierPrefix)so.oxy.mention',
    'ABCDE12345.so.oxy.mention',
    `${P}SO.OXY.MENTION`,
  ]) {
    assert.throws(
      () => assertOxyKeychainGroups('so.oxy.mention', [SHARED, entry]),
      /must spell the keychain access group/,
      entry,
    );
  }
});

// R5-4: `<TEAM>.<bundle id>` is each app's own private group (ADR 0062 D6), so
// an app listing another app's id reads that app's session and items.
test("another app's bundle-id group is refused, in every spelling", () => {
  const cases = [
    ['so.oxy.mention', `${P}to.peable.app`],
    ['so.oxy.mention', `${P}so.oxy.commons`],
    ['so.oxy.mention', 'to.peable.app.dev'],
    ['so.oxy.mention', `${P}to.peable.app.dev`],
    ['so.oxy.mention', '$(TeamIdentifierPrefix)so.oxy.commons'],
    ['so.oxy.mention', 'ABCDE12345.to.peable.app'],
    ['so.oxy.mention', `${P}so.oxy.accounts`],
    ['so.oxy.mention', `${P}so.oxy.mention.dev`],
    ['so.oxy.mention.dev', `${P}so.oxy.mention`],
    ['to.peable.orbit', `${P}to.peable.app`],
    // The holders too: another holder's, or the other variant's, own group.
    ['to.peable.app', `${P}so.oxy.commons`],
    ['so.oxy.commons', `${P}to.peable.app`],
    ['so.oxy.commons.dev', `${P}so.oxy.commons`],
    ['to.peable.app.dev', `${P}to.peable.app`],
    [undefined, `${P}so.oxy.commons`],
  ];
  for (const [id, entry] of cases) {
    const layout = keychainEntries(keychainGroupsFor(id));
    for (const groups of [
      [...layout, entry],
      [entry, ...layout],
    ]) {
      assert.throws(
        () => assertOxyKeychainGroups(id, groups),
        /may not list the keychain access group .*not one of this app's groups/,
        `${id} ${JSON.stringify(groups)}`,
      );
    }
    // Declared straight in the app config, past the preset (withOxyUpdates).
    assert.throws(
      () => withOxyKeychainPolicy(app(id, { 'keychain-access-groups': [...layout, entry] })),
      /may not list/,
      `${id} ${entry}`,
    );
    // And through the preset's own plugin: kept, then refused, never repaired.
    assert.throws(
      () => withOxyKeychain(app(id), [...keychainGroupsFor(id), entry]),
      /may not list/,
    );
  }
});

test('any group that is not one of the Oxy groups the bundle id holds is refused', () => {
  for (const entry of [
    `${P}com.example.other`,
    `${P}so.oxy.identityx`,
    `${P}group.so.oxy.identity`,
    `${P}group.so.oxy.shared.dev`,
    'ABCDE12345.com.example.other',
  ]) {
    assert.throws(
      () => assertOxyKeychainGroups('so.oxy.mention', [SHARED, entry]),
      /may not list/,
      entry,
    );
  }
});

test('each app may ship exactly its layout, optionally followed by its own application group', () => {
  const accepted = [
    ['so.oxy.commons', [IDENTITY, WALLET, SHARED]],
    ['so.oxy.commons', [IDENTITY, WALLET, SHARED, `${P}so.oxy.commons`]],
    ['so.oxy.commons.dev', [IDENTITY_DEV, WALLET_DEV, SHARED]],
    ['so.oxy.commons.dev', [IDENTITY_DEV, WALLET_DEV, SHARED, `${P}so.oxy.commons.dev`]],
    ['to.peable.app', [WALLET, SHARED]],
    ['to.peable.app', [WALLET, SHARED, `${P}to.peable.app`]],
    ['to.peable.app.dev', [WALLET_DEV, SHARED]],
    ['to.peable.app.dev', [WALLET_DEV, SHARED, `${P}to.peable.app.dev`]],
    ['so.oxy.mention', [SHARED]],
    ['so.oxy.mention', [SHARED, `${P}so.oxy.mention`]],
    ['to.peable.orbit', [SHARED]],
    // A holder before its split build: the shared group alone reads nothing secret.
    ['to.peable.app', [SHARED]],
    ['so.oxy.commons', [SHARED]],
    // No group at all, like an app without the entitlement.
    ['so.oxy.mention', []],
    [undefined, [SHARED]],
  ];
  for (const [id, groups] of accepted) {
    assert.doesNotThrow(() => assertOxyKeychainGroups(id, groups), `${id} ${groups}`);
    assert.doesNotThrow(
      () => withOxyKeychainPolicy(app(id, { 'keychain-access-groups': groups })),
      `${id} ${groups}`,
    );
  }
  assert.doesNotThrow(() =>
    assertOxyKeychainGroups(
      'to.peable.app',
      ['ABCDE12345.so.oxy.wallet', 'ABCDE12345.group.so.oxy.shared', 'ABCDE12345.to.peable.app'],
      { teamId: 'ABCDE12345' },
    ),
  );

  const refused = [
    // Duplicates, a missing shared group, the own group first or in the middle.
    ['so.oxy.mention', [SHARED, SHARED]],
    ['so.oxy.mention', [`${P}so.oxy.mention`, SHARED]],
    ['so.oxy.commons', [IDENTITY, WALLET]],
    ['so.oxy.commons', [IDENTITY, SHARED]],
    ['so.oxy.commons', [IDENTITY, WALLET, `${P}so.oxy.commons`, SHARED]],
    ['so.oxy.commons', [IDENTITY, WALLET, SHARED, SHARED]],
    ['to.peable.app', [WALLET]],
    ['to.peable.app', [WALLET, SHARED, `${P}to.peable.app`, `${P}to.peable.app`]],
  ];
  for (const [id, groups] of refused) {
    assert.throws(
      () => assertOxyKeychainGroups(id, groups),
      /must list its keychain access groups as exactly/,
      `${id} ${groups}`,
    );
  }
});

test('a bundle id whose first label looks like a team id still owns its application group', () => {
  assert.doesNotThrow(() =>
    assertOxyKeychainGroups('abcdefghij.example', [SHARED, `${P}abcdefghij.example`]),
  );
  assert.throws(
    () => assertOxyKeychainGroups('abcdefghij.example', [SHARED, `${P}example`]),
    /may not list/,
  );
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
 * An app.config.js of this repository (Commons, Accounts), evaluated for a
 * variant. Its only build-time dependency outside this repository's plain
 * CommonJS is the splash plugin factory, which is stubbed: only `ios` is read
 * here.
 */
function loadAppConfig(dir, variant) {
  const path = resolve(__dirname, '../..', dir, 'app.config.js');
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
    const expo = loadAppConfig('commons', variant);
    assert.equal(expo.ios.bundleIdentifier, id);
    const groups = expo.ios.entitlements['keychain-access-groups'];
    assert.deepEqual(groups, keychainEntries(keychainGroupsFor(id)));
    assert.doesNotThrow(() => withOxyKeychainPolicy(expo));
  }
});

test('Accounts lists the shared group only, in both variants, and the policy accepts it', () => {
  for (const [variant, id] of [
    [undefined, 'so.oxy.accounts'],
    ['development', 'so.oxy.accounts.dev'],
  ]) {
    const expo = loadAppConfig('accounts', variant);
    assert.equal(expo.ios.bundleIdentifier, id);
    assert.deepEqual(expo.ios.entitlements['keychain-access-groups'], [SHARED]);
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
