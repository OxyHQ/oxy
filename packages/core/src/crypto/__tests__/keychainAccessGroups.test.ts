/**
 * The iOS keychain access-group split (docs/identity/ios-keychain-access-groups.md,
 * ADR 0062), against a keychain fake with Apple's group semantics.
 *
 * A "launch" is a fresh module graph over the SAME keychain, with the
 * entitlements of a build: `preSplit` (every Oxy app before the split, with a
 * native module that predates the probe), Commons `[identity, wallet, shared]`,
 * the Peable wallet `[wallet, shared]`, any other app `[shared]`.
 */
import { APP, ENTITLEMENTS, FakeKeychain, GROUP } from './fakeKeychain';

const mockKeychain = new FakeKeychain();
let mockProbe: 'native' | 'unsupported' = 'unsupported';

jest.mock('@oxy.so/protocol', () => ({
  __esModule: true,
  ...jest.requireActual('@oxy.so/protocol'),
  loadSecureStore: async () => mockKeychain,
  loadKeychainDefaultAccessGroup: async () =>
    mockProbe === 'native' ? mockKeychain.probe() : { state: 'unsupported' },
  loadKeychainApplicationAccessGroup: async (prefix: string) =>
    mockProbe === 'native' ? mockKeychain.applicationProbe(prefix) : { state: 'unsupported' },
  loadNodeCrypto: async () => require('node:crypto'),
  loadCommonsIdentityBridge: async () => null,
}));

const PRIVATE = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ORG = '0123456789abcdef01234567';
const LABEL = 'peable/faircoin/v1';
const DIGEST = 'ab'.repeat(32);

type Launch = Awaited<ReturnType<typeof launch>>;

async function launch(entitlements: string[], probe: 'native' | 'unsupported' = 'native') {
  jest.resetModules();
  mockKeychain.entitlements = [...entitlements];
  mockProbe = probe;
  (await import('../../utils/platform')).setPlatformOS('ios');
  const { KeyManager } = await import('../keyManager');
  const org = await import('../organizationKeys');
  const migration = await import('../keychainGroupMigration');
  const groups = await import('../../utils/keychainAccessGroups');
  return { KeyManager, org, migration, groups };
}

const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString('hex') : null);

/** Everything a person and their organization hold, written by today's Commons. */
async function seedPreSplitCommons(): Promise<{
  publicKey: string;
  orgPrivate: string;
  orgPhrase: string;
  seed: string | null;
  orgSeed: string | null;
}> {
  mockKeychain.items.clear();
  const { KeyManager, org } = await launch(ENTITLEMENTS.preSplit, 'unsupported');
  await KeyManager.importKeyPair(PRIVATE, { overwrite: true });
  await KeyManager.storeRecoveryMnemonic(PHRASE);
  expect(await KeyManager.syncSharedIdentity()).toBe(true);
  const orgKey = await org.generateOrganizationKey();
  await org.storeOrganizationKey(ORG, orgKey);
  return {
    publicKey: KeyManager.derivePublicKey(PRIVATE),
    orgPrivate: orgKey.privateKey,
    orgPhrase: orgKey.mnemonic,
    seed: hex(await KeyManager.deriveScopedSeed(LABEL)),
    orgSeed: hex(await KeyManager.deriveScopedSeed(LABEL, { accountId: ORG })),
  };
}

/** What Commons can read, through the SDK's own read paths. */
async function commonsView(l: Launch) {
  return {
    privateKey: await l.KeyManager.getPrivateKey(),
    phrase: await l.KeyManager.getRecoveryMnemonic(),
    sharedPublic: await l.KeyManager.getSharedPublicKey(),
    seed: hex(await l.KeyManager.deriveScopedSeed(LABEL)),
    orgPrivate: await l.org.getOrganizationPrivateKey(ORG),
    orgPhrase: await l.org.getOrganizationRecoveryPhrase(ORG),
    orgs: await l.org.listOrganizationKeys(),
  };
}

const SECRET_NAMES: Array<[string, string | undefined]> = [
  ['oxy_identity_private_key_v2', 'oxy_identity'],
  ['oxy_identity_backup_private_key_v2', 'oxy_identity_backup'],
  ['oxy_identity_mnemonic_v1', 'oxy_identity_mnemonic'],
  ['oxy_shared_identity_private_key', undefined],
  [`oxy_org_identity_private_key.${ORG}`, undefined],
  [`oxy_org_identity_mnemonic.${ORG}`, 'oxy_org_identity_mnemonic'],
];

/** Every secret a sibling app could read straight from the keychain (no SDK). */
function secretsInSharedGroup(): string[] {
  return SECRET_NAMES.filter(([key, service]) => mockKeychain.get(GROUP.shared, key, service)).map(
    ([key]) => key,
  );
}

beforeEach(() => {
  mockKeychain.items.clear();
  mockKeychain.application = null;
  mockKeychain.failReadGroups.clear();
  mockKeychain.locked = false;
  mockKeychain.failMutationAt = null;
  mockKeychain.failWrites.clear();
  mockKeychain.corruptWrites.clear();
  mockKeychain.calls.length = 0;
});

describe('keychainAccessFromDefaultGroup', () => {
  it('derives the team prefix and the role from the default group', async () => {
    const { groups } = await launch(ENTITLEMENTS.commons);
    expect(groups.keychainAccessFromDefaultGroup(GROUP.identity)).toEqual({
      mode: 'grouped',
      prefix: 'ABCDE12345.',
      defaultGroup: GROUP.identity,
      role: 'holder',
    });
    expect(groups.keychainAccessFromDefaultGroup(GROUP.wallet)).toMatchObject({ role: 'wallet' });
    expect(groups.keychainAccessFromDefaultGroup(GROUP.shared)).toMatchObject({ role: 'member' });
    // An app with no keychain-access-groups defaults to its application identifier.
    expect(groups.keychainAccessFromDefaultGroup('ABCDE12345.so.oxy.mention')).toMatchObject({
      role: 'member',
    });
    expect(groups.keychainAccessFromDefaultGroup('nodot')).toEqual({ mode: 'ungrouped' });
  });

  it('assigns each item class one group, and each role only its groups', async () => {
    const { groups } = await launch(ENTITLEMENTS.commons);
    expect(groups.keychainGroupFor('identity-secret')).toBe('identity');
    expect(groups.keychainGroupFor('spending-key')).toBe('wallet');
    expect(groups.keychainGroupFor('shared')).toBe('shared');
    const access = groups.keychainAccessFromDefaultGroup(GROUP.shared);
    expect(groups.keychainReadPlan(access, 'identity-secret')).toEqual([]);
    expect(groups.keychainReadPlan(access, 'spending-key')).toEqual([]);
    expect(groups.keychainReadPlan(access, 'shared')).toEqual([{ accessGroup: GROUP.shared }]);
    expect(() => groups.keychainWriteOption(access, 'identity-secret')).toThrow();
    const wallet = groups.keychainAccessFromDefaultGroup(GROUP.wallet);
    expect(groups.keychainReadPlan(wallet, 'spending-key')).toEqual([
      { accessGroup: GROUP.wallet },
      { accessGroup: GROUP.shared },
    ]);
    expect(groups.keychainReadPlan(wallet, 'identity-secret')).toEqual([]);
    expect(groups.ownKeychainItemPlan(wallet)).toEqual({
      read: [{ accessGroup: GROUP.wallet }, {}],
      write: { accessGroup: GROUP.wallet },
      delete: [{}],
    });
    // Every other app keeps exactly the calls it made before the split.
    expect(groups.ownKeychainItemPlan(access)).toEqual({ read: [{}], write: {}, delete: [{}] });
  });

  it('puts an app’s own items in its own group (ADR 0062 D6)', async () => {
    const { groups } = await launch(ENTITLEMENTS.commons);
    expect(groups.keychainGroupFor('app')).toBe('app');
    const member = groups.keychainAccessFromDefaultGroup(GROUP.shared, APP.mention);
    const commons = groups.keychainAccessFromDefaultGroup(GROUP.identity, APP.commons);
    const wallet = groups.keychainAccessFromDefaultGroup(GROUP.wallet, APP.wallet);
    expect(member).toMatchObject({ role: 'member', appGroup: APP.mention });
    // A group of another team is not this app's.
    expect(
      groups.keychainAccessFromDefaultGroup(GROUP.shared, 'XYZ.so.oxy.mention'),
    ).not.toHaveProperty('appGroup');
    expect(groups.mayHoldKeychainItem('member', 'app')).toBe(true);
    expect(groups.keychainReadPlan(member, 'app')).toEqual([{ accessGroup: APP.mention }]);
    expect(groups.keychainWriteOption(member, 'app')).toEqual({ accessGroup: APP.mention });

    const app = { accessGroup: APP.mention };
    // A name no other app writes: every copy this app can read is its own.
    expect(groups.ownKeychainItemPlan(member)).toEqual({
      read: [app, {}],
      write: app,
      delete: [{}],
    });
    // A name every Oxy app writes: never the shared copy.
    expect(groups.ownKeychainItemPlan(member, 'every-oxy-app')).toEqual({
      read: [app],
      write: app,
      delete: [app],
    });
    expect(groups.ownKeychainItemPlan(member, 'every-oxy-app-withholding')).toEqual({
      read: [app, { accessGroup: GROUP.shared }],
      write: app,
      delete: [{ accessGroup: GROUP.shared }, app],
    });
    // Commons and the wallet also read the copy D3 put in their default group,
    // and delete it first.
    const own = { accessGroup: APP.commons };
    const identity = { accessGroup: GROUP.identity };
    expect(groups.ownKeychainItemPlan(commons, 'every-oxy-app')).toEqual({
      read: [own, identity],
      write: own,
      delete: [identity, own],
    });
    expect(groups.ownKeychainItemPlan(wallet)).toEqual({
      read: [{ accessGroup: APP.wallet }, { accessGroup: GROUP.wallet }, {}],
      write: { accessGroup: APP.wallet },
      delete: [{}],
    });
    // Without the application-group probe: Commons and the wallet keep their
    // default group; every other app the one item it always had.
    const commonsSplit = groups.keychainAccessFromDefaultGroup(GROUP.identity);
    expect(groups.ownKeychainItemPlan(commonsSplit, 'every-oxy-app')).toEqual({
      read: [identity],
      write: identity,
      delete: [identity],
    });
    const memberSplit = groups.keychainAccessFromDefaultGroup(GROUP.shared);
    expect(groups.ownKeychainItemPlan(memberSplit, 'every-oxy-app')).toEqual({
      read: [{}],
      write: {},
      delete: [{}],
    });
    expect(groups.ownKeychainItemPlan({ mode: 'ungrouped' }, 'every-oxy-app')).toEqual({
      read: [{}],
      write: {},
      delete: [{}],
    });
  });

  it('resolves the application group from its probe, and never remembers a locked one', async () => {
    mockKeychain.application = APP.mention;
    const { groups } = await launch(ENTITLEMENTS.member);
    mockKeychain.application = APP.mention;
    mockKeychain.locked = true;
    await expect(groups.resolveKeychainAccess()).rejects.toThrow(
      groups.KeychainAccessUnavailableError,
    );
    mockKeychain.locked = false;
    expect(await groups.resolveKeychainAccess()).toEqual({
      mode: 'grouped',
      prefix: 'ABCDE12345.',
      defaultGroup: GROUP.shared,
      role: 'member',
      appGroup: APP.mention,
    });
  });
});

describe('the exposure (F5) and its closing', () => {
  it('before the split every secret sits in the shared group', async () => {
    await seedPreSplitCommons();
    expect(secretsInSharedGroup()).toHaveLength(SECRET_NAMES.length);
  });

  it('Commons moves every secret out of the shared group and still reads the same identity', async () => {
    const before = await seedPreSplitCommons();
    const commons = await launch(ENTITLEMENTS.commons);
    const report = await commons.migration.ensureKeychainGroupsMigrated();
    expect(report.state).toBe('complete');
    expect(secretsInSharedGroup()).toEqual([]);
    // Only the public key is left for every app.
    expect(mockKeychain.inGroup(GROUP.shared)).toEqual([
      `${GROUP.shared}|app|oxy_shared_identity_public_key`,
    ]);
    // Every pair is where the table puts it.
    expect(mockKeychain.get(GROUP.identity, 'oxy_identity_private_key_v2', 'oxy_identity')).toBe(
      PRIVATE,
    );
    expect(
      mockKeychain.get(GROUP.identity, 'oxy_identity_mnemonic_v1', 'oxy_identity_mnemonic'),
    ).toBe(PHRASE);
    expect(mockKeychain.get(GROUP.wallet, 'oxy_shared_identity_private_key')).toBe(PRIVATE);
    expect(mockKeychain.get(GROUP.wallet, `oxy_org_identity_private_key.${ORG}`)).toBe(
      before.orgPrivate,
    );
    expect(
      mockKeychain.get(
        GROUP.identity,
        `oxy_org_identity_mnemonic.${ORG}`,
        'oxy_org_identity_mnemonic',
      ),
    ).toBe(before.orgPhrase);

    const view = await commonsView(await launch(ENTITLEMENTS.commons));
    expect(view).toEqual({
      privateKey: PRIVATE,
      phrase: PHRASE,
      sharedPublic: before.publicKey,
      seed: before.seed,
      orgPrivate: before.orgPrivate,
      orgPhrase: before.orgPhrase,
      orgs: [ORG],
    });
  });

  it('the Peable wallet derives the same wallet before and after the move, and never reads a phrase', async () => {
    const before = await seedPreSplitCommons();
    for (const migrated of [false, true]) {
      if (migrated) {
        await (await launch(ENTITLEMENTS.commons)).migration.ensureKeychainGroupsMigrated();
      }
      const peable = await launch(ENTITLEMENTS.wallet);
      expect(hex(await peable.KeyManager.deriveScopedSeed(LABEL))).toBe(before.seed);
      expect(hex(await peable.KeyManager.deriveScopedSeed(LABEL, { accountId: ORG }))).toBe(
        before.orgSeed,
      );
      expect(await peable.KeyManager.signSocialReceive(0, DIGEST)).not.toBeNull();
      expect(
        await peable.KeyManager.signSocialReceive(0, DIGEST, { accountId: ORG }),
      ).not.toBeNull();
      expect(await peable.org.getOrganizationPublicKey(ORG)).not.toBeNull();
      expect(await peable.KeyManager.getSharedPublicKey()).toBe(before.publicKey);
      expect(await peable.KeyManager.getRecoveryMnemonic()).toBeNull();
      expect(await peable.KeyManager.getPrivateKey()).toBeNull();
      expect(await peable.org.getOrganizationRecoveryPhrase(ORG)).toBeNull();
    }
  });

  it('every other app reads only the public key, never touching the private items', async () => {
    const before = await seedPreSplitCommons();
    const mention = await launch(ENTITLEMENTS.member);
    mockKeychain.calls.length = 0;
    expect(await mention.KeyManager.getSharedPrivateKey()).toBeNull();
    expect(await mention.KeyManager.hasSharedIdentity()).toBe(false);
    expect(await mention.KeyManager.getPrivateKey()).toBeNull();
    expect(await mention.KeyManager.getRecoveryMnemonic()).toBeNull();
    expect(await mention.KeyManager.deriveScopedSeed(LABEL)).toBeNull();
    expect(await mention.KeyManager.signSocialReceive(0, DIGEST)).toBeNull();
    expect(await mention.org.getOrganizationPrivateKey(ORG)).toBeNull();
    expect(mockKeychain.calls.filter((c) => c.op === 'get').map((c) => c.key)).not.toContainEqual(
      expect.stringMatching(/private_key|mnemonic/),
    );
    expect(await mention.KeyManager.getSharedPublicKey()).toBe(before.publicKey);
    // And no app but Commons can create a second holder.
    await expect(mention.KeyManager.importKeyPair(PRIVATE, { overwrite: true })).rejects.toThrow();
  });

  it('in-process proof sign-in is off outside Commons and the wallet, so the dialog takes the Commons round-trip', async () => {
    await seedPreSplitCommons();
    const mention = await launch(ENTITLEMENTS.member);
    const { SignatureService } = await import('../signatureService');
    await expect(SignatureService.signChallengeWithSharedKey('00'.repeat(32))).rejects.toThrow(
      /No shared identity/,
    );
    expect(await mention.KeyManager.hasSharedIdentity()).toBe(false);
  });

  it('a build without the probe keeps the single-group behaviour it was made for', async () => {
    await seedPreSplitCommons();
    const old = await launch(ENTITLEMENTS.preSplit, 'unsupported');
    expect(await old.KeyManager.getSharedPrivateKey()).toBe(PRIVATE);
    expect(mockKeychain.calls.every((c) => c.options.accessGroup === undefined)).toBe(true);
  });
});

describe('Commons writes each item to its group, team prefix included', () => {
  it('a new identity, its phrase, the shared slot and an organization', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    await commons.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    await commons.KeyManager.storeRecoveryMnemonic(PHRASE);
    await commons.KeyManager.syncSharedIdentity();
    const orgKey = await commons.org.generateOrganizationKey();
    await commons.org.storeOrganizationKey(ORG, orgKey);
    const writes = mockKeychain.calls.filter((c) => c.op === 'set');
    const groupOf = (key: string) => writes.find((w) => w.key === key)?.options.accessGroup;
    expect(groupOf('oxy_identity_private_key_v2')).toBe(GROUP.identity);
    expect(groupOf('oxy_identity_backup_private_key_v2')).toBe(GROUP.identity);
    expect(groupOf('oxy_identity_mnemonic_v1')).toBe(GROUP.identity);
    expect(groupOf('oxy_shared_identity_private_key')).toBe(GROUP.wallet);
    expect(groupOf('oxy_shared_identity_public_key')).toBe(GROUP.shared);
    expect(groupOf(`oxy_org_identity_private_key.${ORG}`)).toBe(GROUP.wallet);
    expect(groupOf(`oxy_org_identity_mnemonic.${ORG}`)).toBe(GROUP.identity);
    expect(groupOf('oxy_org_identity_index_v1')).toBe(GROUP.identity);
    expect(writes.every((w) => w.options.accessGroup !== undefined)).toBe(true);
    expect(secretsInSharedGroup()).toEqual([]);
  });

  it('a forced delete leaves no copy in any group', async () => {
    await seedPreSplitCommons();
    const commons = await launch(ENTITLEMENTS.commons);
    await commons.KeyManager.deleteIdentity(false, true, true);
    for (const group of Object.values(GROUP)) {
      expect(mockKeychain.get(group, 'oxy_identity_private_key_v2', 'oxy_identity')).toBeNull();
      expect(mockKeychain.get(group, 'oxy_shared_identity_private_key')).toBeNull();
    }
  });
});

describe('retired keys (ADR 0061 D7 as amended) are spending keys', () => {
  const RETIRED = '6c'.repeat(32);

  it('Commons keeps them in the wallet group; the wallet derives by selector; no other app can', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    await commons.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    const ring = await import('../retiredKeys');
    const publicKey = commons.KeyManager.derivePublicKey(RETIRED);
    await ring.retireIdentityKey({ privateKey: RETIRED, publicKey });
    const writes = mockKeychain.calls.filter((c) => c.op === 'set');
    const retiredWrites = writes.filter((w) => w.key.startsWith('oxy_retired_identity'));
    expect(retiredWrites.length).toBeGreaterThan(0);
    expect(retiredWrites.every((w) => w.options.accessGroup === GROUP.wallet)).toBe(true);
    for (const w of retiredWrites) {
      expect(mockKeychain.get(GROUP.shared, w.key, w.options.keychainService)).toBeNull();
    }

    const peable = await launch(ENTITLEMENTS.wallet);
    const seed = await peable.KeyManager.deriveScopedSeed(LABEL, { publicKey });
    expect(hex(seed)).not.toBeNull();
    const peableRing = await import('../retiredKeys');
    expect((await peableRing.listRetiredIdentityKeys()).map((k) => k.publicKey)).toEqual([
      publicKey,
    ]);

    const member = await launch(ENTITLEMENTS.member);
    await expect(member.KeyManager.deriveScopedSeed(LABEL, { publicKey })).resolves.toBeNull();
  });
});

describe('the migration never loses a key', () => {
  it('a locked keychain defers without writing, and the next access completes', async () => {
    await seedPreSplitCommons();
    mockKeychain.locked = true;
    const commons = await launch(ENTITLEMENTS.commons);
    const mutations = mockKeychain.mutations;
    expect((await commons.migration.ensureKeychainGroupsMigrated()).state).toBe('deferred');
    expect(await commons.KeyManager.getPrivateKey()).toBeNull();
    expect(mockKeychain.mutations).toBe(mutations);
    mockKeychain.locked = false;
    expect(await commons.KeyManager.getPrivateKey()).toBe(PRIVATE);
    expect((await commons.migration.ensureKeychainGroupsMigrated()).state).toBe('complete');
    expect(secretsInSharedGroup()).toEqual([]);
  });

  it('a copy that fails leaves the item in the shared group, readable, and the next launch moves it', async () => {
    await seedPreSplitCommons();
    mockKeychain.failWrites.add(`${GROUP.identity}|oxy_identity_mnemonic_v1`);
    const commons = await launch(ENTITLEMENTS.commons);
    const report = await commons.migration.ensureKeychainGroupsMigrated();
    expect(report.state).toBe('incomplete');
    expect(report.items.phrase).toBe('failed');
    expect(report.items.primary).toBe('moved');
    expect(await commons.KeyManager.getRecoveryMnemonic()).toBe(PHRASE);
    expect(secretsInSharedGroup()).toEqual(['oxy_identity_mnemonic_v1']);
    mockKeychain.failWrites.clear();
    const next = await launch(ENTITLEMENTS.commons);
    expect((await next.migration.ensureKeychainGroupsMigrated()).state).toBe('complete');
    expect(await next.KeyManager.getRecoveryMnemonic()).toBe(PHRASE);
  });

  it('a copy that reads back wrong is removed again and the original stays', async () => {
    await seedPreSplitCommons();
    mockKeychain.corruptWrites.set(`${GROUP.identity}|oxy_identity_mnemonic_v1`, 'garbage');
    const commons = await launch(ENTITLEMENTS.commons);
    expect((await commons.migration.ensureKeychainGroupsMigrated()).items.phrase).toBe('failed');
    expect(
      mockKeychain.get(GROUP.identity, 'oxy_identity_mnemonic_v1', 'oxy_identity_mnemonic'),
    ).toBeNull();
    expect(await commons.KeyManager.getRecoveryMnemonic()).toBe(PHRASE);
  });

  it('an unhealthy pair is never moved', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const other = commons.KeyManager.derivePublicKey('11'.repeat(32));
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', PRIVATE, 'oxy_identity');
    mockKeychain.put(GROUP.shared, 'oxy_identity_public_key_v2', other, 'oxy_identity');
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items.primary).toBe('unhealthy');
    expect(mockKeychain.get(GROUP.shared, 'oxy_identity_private_key_v2', 'oxy_identity')).toBe(
      PRIVATE,
    );
    expect(
      mockKeychain.get(GROUP.identity, 'oxy_identity_private_key_v2', 'oxy_identity'),
    ).toBeNull();
  });

  it('two different keys are both kept (a replaced key may still receive money)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const replaced = '22'.repeat(32);
    mockKeychain.put(GROUP.shared, 'oxy_shared_identity_private_key', replaced);
    mockKeychain.put(
      GROUP.shared,
      'oxy_shared_identity_public_key',
      commons.KeyManager.derivePublicKey(PRIVATE),
    );
    mockKeychain.put(GROUP.wallet, 'oxy_shared_identity_private_key', PRIVATE);
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items['shared-slot']).toBe('conflict');
    expect(mockKeychain.get(GROUP.shared, 'oxy_shared_identity_private_key')).toBe(replaced);
    expect(mockKeychain.get(GROUP.wallet, 'oxy_shared_identity_private_key')).toBe(PRIVATE);
  });

  it('organization indexes in both groups are merged, never narrowed', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    mockKeychain.put(
      GROUP.shared,
      'oxy_org_identity_index_v1',
      JSON.stringify([a]),
      'oxy_org_identity_index',
    );
    mockKeychain.put(
      GROUP.identity,
      'oxy_org_identity_index_v1',
      JSON.stringify([b]),
      'oxy_org_identity_index',
    );
    expect((await commons.migration.runKeychainGroupMigration()).items['organization-index']).toBe(
      'moved',
    );
    expect(await commons.org.listOrganizationKeys()).toEqual([a, b]);
  });

  // Every mutation of a clean run, in turn, is where the process dies (every
  // later mutation in that launch fails too) or where one write fails alone.
  // After each, every secret must still be readable with its original value,
  // and the next clean launch must finish the move.
  it('survives a crash or a single failure at every step', async () => {
    const before = await seedPreSplitCommons();
    const snapshot = new Map(mockKeychain.items);
    const start = mockKeychain.mutations;
    await (await launch(ENTITLEMENTS.commons)).migration.ensureKeychainGroupsMigrated();
    const steps = mockKeychain.mutations - start;
    expect(steps).toBeGreaterThan(10);
    const expected = {
      privateKey: PRIVATE,
      phrase: PHRASE,
      sharedPublic: before.publicKey,
      seed: before.seed,
      orgPrivate: before.orgPrivate,
      orgPhrase: before.orgPhrase,
      orgs: [ORG],
    };

    for (const mode of ['crash', 'single'] as const) {
      for (let k = 1; k <= steps; k += 1) {
        mockKeychain.items.clear();
        for (const [id, v] of snapshot) mockKeychain.items.set(id, v);
        const commons = await launch(ENTITLEMENTS.commons);
        const base = mockKeychain.mutations;
        const original = mockKeychain.setItemAsync;
        const originalDelete = mockKeychain.deleteItemAsync;
        let n = 0;
        const fault = () => {
          n += 1;
          if (mode === 'crash' ? n >= k : n === k) throw new Error(`fault at ${k}`);
        };
        mockKeychain.setItemAsync = async (...args) => {
          fault();
          return original(...args);
        };
        mockKeychain.deleteItemAsync = async (...args) => {
          fault();
          return originalDelete(...args);
        };
        await commons.migration.ensureKeychainGroupsMigrated();
        mockKeychain.setItemAsync = original;
        mockKeychain.deleteItemAsync = originalDelete;
        expect(mockKeychain.mutations).toBeGreaterThanOrEqual(base);

        // The state the fault left, before any later launch repairs it: every
        // value still has a copy, and no copy anywhere holds anything else.
        for (const [id, value] of snapshot) {
          const [, service, key] = id.split('|');
          const copies = Object.values(GROUP)
            .map((g) => mockKeychain.get(g, key, service === 'app' ? undefined : service))
            .filter((v) => v !== null);
          expect(copies.length).toBeGreaterThan(0);
          expect(new Set(copies)).toEqual(new Set([value]));
        }
        // The wallet does not migrate: it reads that intermediate state as is.
        const peable = await launch(ENTITLEMENTS.wallet);
        expect(hex(await peable.KeyManager.deriveScopedSeed(LABEL))).toBe(before.seed);
        expect(hex(await peable.KeyManager.deriveScopedSeed(LABEL, { accountId: ORG }))).toBe(
          before.orgSeed,
        );

        const next = await launch(ENTITLEMENTS.commons);
        expect((await next.migration.ensureKeychainGroupsMigrated()).state).toBe('complete');
        expect(secretsInSharedGroup()).toEqual([]);
        expect(await commonsView(next)).toEqual(expected);
      }
    }
  });
});
