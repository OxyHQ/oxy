/**
 * The iOS keychain access-group split (docs/identity/ios-keychain-access-groups.md,
 * ADR 0062), against a keychain fake with Apple's group semantics.
 *
 * A "launch" is a fresh module graph over the SAME keychain, with the
 * entitlements of a build: `preSplit` (every Oxy app before the split, with a
 * native module that predates the probe), Commons `[identity, wallet, shared]`,
 * the Peable wallet `[wallet, shared]`, any other app `[shared]`.
 */
import { deriveScopedSeedFromKey } from '../identityDerivations';
import { APP, ENTITLEMENTS, FakeKeychain, GROUP, sandbox } from './fakeKeychain';

const mockKeychain = new FakeKeychain();
let mockProbe: 'native' | 'unsupported' = 'unsupported';
/**
 * The `OxyIdentity` read without user interaction (R5-9), or `null` for a
 * native module that predates it. Items in `mockAuthOnly` model a copy stored
 * with `requireAuthentication`: expo-secure-store's read would prompt for it
 * (the fake throws), this reader never sees it.
 */
let mockNoInteraction = false;
const mockAuthOnly = new Set<string>();
const mockNoInteractionReads: string[] = [];

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
  loadKeychainReadWithoutInteraction: async () =>
    mockNoInteraction
      ? async (key: string, service: string | undefined, accessGroup: string) => {
          mockNoInteractionReads.push(`${accessGroup}|${key}`);
          return mockKeychain.get(accessGroup, key, service);
        }
      : null,
}));

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** `mnemonicToSeed(PHRASE)[0:32]`: the phrase derives the root, as on a real device. */
const PRIVATE = '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1';
const ORG = '0123456789abcdef01234567';
const LABEL = 'peable/faircoin/v1';
const OWNER = { ownerAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
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

/** Commons' sandbox marker naming `publicKey`: what an upgraded Commons has. */
function proveOwner(publicKey: string): void {
  sandbox.set(
    'oxy_identity_marker_v1',
    JSON.stringify({ v: 1, publicKey, createdAt: 1, origin: 'import' }),
  );
}

/** Everything a person and their organization hold, written by today's Commons. */
async function seedPreSplitCommons(): Promise<{
  publicKey: string;
  orgPrivate: string;
  orgPublic: string;
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
    orgPublic: orgKey.publicKey,
    orgPhrase: orgKey.mnemonic,
    seed: hex(await KeyManager.deriveScopedSeed(LABEL)),
    orgSeed: hex(await KeyManager.deriveScopedSeed(LABEL, { accountId: ORG })),
  };
}

/** The organization key kept in its ring, by public key (wallet group). */
function orgRingHolds(privateKey: string, publicKey: string, accountId = ORG): boolean {
  return (
    mockKeychain.get(GROUP.wallet, `oxy_retired_identity_private_key.${accountId}.${publicKey}`) ===
    privateKey
  );
}

/**
 * What Commons' launch does once it can ask Oxy (R5-7): bind the quarantined
 * organization entries the organization's key history names and make its
 * current key the live pair again.
 */
async function bindOrganization(l: Launch, orgPublic: string): Promise<void> {
  const ring = await import('../retiredKeys');
  expect(await ring.listQuarantinedOrganizationKeys()).toContainEqual({
    accountId: ORG,
    publicKey: orgPublic,
  });
  await ring.claimRetiredOrganizationKeys(ORG, [orgPublic]);
  expect(await l.org.adoptOrganizationKeyFromRing(ORG, orgPublic)).toBe(true);
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
  sandbox.clear();
  mockKeychain.items.clear();
  mockKeychain.application = null;
  mockKeychain.failReadGroups.clear();
  mockKeychain.locked = false;
  mockKeychain.failMutationAt = null;
  mockKeychain.failWrites.clear();
  mockKeychain.corruptWrites.clear();
  mockKeychain.calls.length = 0;
  mockNoInteraction = false;
  mockAuthOnly.clear();
  mockNoInteractionReads.length = 0;
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
    // A development build's restricted groups are its own (R4-14).
    expect(groups.keychainAccessFromDefaultGroup(`${GROUP.identity}.dev`)).toMatchObject({
      role: 'holder',
      variant: '.dev',
    });
    expect(groups.keychainAccessFromDefaultGroup(`${GROUP.wallet}.dev`)).toMatchObject({
      role: 'wallet',
      variant: '.dev',
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
    // The organization's copy is not adopted on the marker's word (R5-7): it
    // is kept quarantined in its ring, out of reach, and not indexed.
    expect(mockKeychain.get(GROUP.wallet, `oxy_org_identity_private_key.${ORG}`)).toBeNull();
    expect(orgRingHolds(before.orgPrivate, before.orgPublic)).toBe(true);
    expect(report.items['organization-1']).toBe('retired');
    const quarantined = await launch(ENTITLEMENTS.commons);
    expect(await quarantined.org.getOrganizationPrivateKey(ORG)).toBeNull();
    expect(await quarantined.org.listOrganizationKeys()).toEqual([]);

    // Commons binds it against the organization's key history and restores it.
    await bindOrganization(quarantined, before.orgPublic);
    const view = await commonsView(await launch(ENTITLEMENTS.commons));
    expect(view).toEqual({
      privateKey: PRIVATE,
      phrase: PHRASE,
      sharedPublic: before.publicKey,
      seed: before.seed,
      orgPrivate: before.orgPrivate,
      // A phrase is never kept in the ring: the owner wrote it down.
      orgPhrase: null,
      orgs: [ORG],
    });
  });

  it('the Peable wallet derives the same wallet before and after the move, and never reads a phrase', async () => {
    const before = await seedPreSplitCommons();
    for (const migrated of [false, true]) {
      if (migrated) {
        const commons = await launch(ENTITLEMENTS.commons);
        await commons.migration.ensureKeychainGroupsMigrated();
        await bindOrganization(commons, before.orgPublic);
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
    await ring.retireIdentityKey({ privateKey: RETIRED, publicKey }, OWNER);
    const writes = mockKeychain.calls.filter((c) => c.op === 'set');
    const retiredWrites = writes.filter((w) => w.key.startsWith('oxy_retired_identity'));
    expect(retiredWrites.length).toBeGreaterThan(0);
    expect(retiredWrites.every((w) => w.options.accessGroup === GROUP.wallet)).toBe(true);
    for (const w of retiredWrites) {
      expect(mockKeychain.get(GROUP.shared, w.key, w.options.keychainService)).toBeNull();
    }

    const peable = await launch(ENTITLEMENTS.wallet);
    const seed = await peable.KeyManager.deriveScopedSeed(LABEL, { publicKey, ...OWNER });
    expect(hex(seed)).not.toBeNull();
    const peableRing = await import('../retiredKeys');
    expect((await peableRing.listRetiredIdentityKeys(OWNER)).map((k) => k.publicKey)).toEqual([
      publicKey,
    ]);

    const member = await launch(ENTITLEMENTS.member);
    await expect(
      member.KeyManager.deriveScopedSeed(LABEL, { publicKey, ...OWNER }),
    ).resolves.toBeNull();
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

  it('an unhealthy pair holding the proven key is adopted with the public key it derives', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const owner = commons.KeyManager.derivePublicKey(PRIVATE);
    proveOwner(owner);
    const other = commons.KeyManager.derivePublicKey('11'.repeat(32));
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', PRIVATE, 'oxy_identity');
    mockKeychain.put(GROUP.shared, 'oxy_identity_public_key_v2', other, 'oxy_identity');
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items.primary).toBe('moved');
    expect(mockKeychain.get(GROUP.identity, 'oxy_identity_public_key_v2', 'oxy_identity')).toBe(
      owner,
    );
    expect(
      mockKeychain.get(GROUP.shared, 'oxy_identity_private_key_v2', 'oxy_identity'),
    ).toBeNull();
    expect(await commons.KeyManager.getPrivateKey()).toBe(PRIVATE);
  });

  it('a different key in the shared group is retired, read back, then deleted (R4-6)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    proveOwner(commons.KeyManager.derivePublicKey(PRIVATE));
    const replaced = '22'.repeat(32);
    const replacedPublic = commons.KeyManager.derivePublicKey(replaced);
    mockKeychain.put(GROUP.shared, 'oxy_shared_identity_private_key', replaced);
    mockKeychain.put(
      GROUP.shared,
      'oxy_shared_identity_public_key',
      commons.KeyManager.derivePublicKey(PRIVATE),
    );
    mockKeychain.put(GROUP.wallet, 'oxy_shared_identity_private_key', PRIVATE);
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items['shared-slot']).toBe('retired');
    expect(report.state).toBe('complete');
    expect(mockKeychain.get(GROUP.shared, 'oxy_shared_identity_private_key')).toBeNull();
    expect(mockKeychain.get(GROUP.wallet, 'oxy_shared_identity_private_key')).toBe(PRIVATE);
    expect(
      mockKeychain.get(GROUP.wallet, `oxy_retired_identity_private_key.personal.${replacedPublic}`),
    ).toBe(replaced);
    // Kept QUARANTINED (R5-2, R5-3): whose key it was is unknown, so nobody
    // reaches it until the account's key history names it.
    const peable = await launch(ENTITLEMENTS.wallet);
    const owner = { ownerAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
    await expect(
      peable.KeyManager.deriveScopedSeed(LABEL, { publicKey: replacedPublic, ...owner }),
    ).resolves.toBeNull();
    await launch(ENTITLEMENTS.commons);
    const commonsRing = await import('../retiredKeys');
    await expect(
      commonsRing.claimRetiredIdentityKeys(owner.ownerAccountId, [replacedPublic]),
    ).resolves.toBe(1);
    const wallet = await launch(ENTITLEMENTS.wallet);
    expect(
      hex(await wallet.KeyManager.deriveScopedSeed(LABEL, { publicKey: replacedPublic, ...owner })),
    ).not.toBeNull();
  });

  it('a different key that cannot be kept in the ring stays where it is, and the run is retried', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    proveOwner(commons.KeyManager.derivePublicKey(PRIVATE));
    const replaced = '22'.repeat(32);
    mockKeychain.put(GROUP.shared, 'oxy_shared_identity_private_key', replaced);
    mockKeychain.put(GROUP.wallet, 'oxy_shared_identity_private_key', PRIVATE);
    mockKeychain.failWrites.add(
      `${GROUP.wallet}|oxy_retired_identity_private_key.personal.${commons.KeyManager.derivePublicKey(replaced)}`,
    );
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items['shared-slot']).toBe('failed');
    expect(report.state).toBe('incomplete');
    expect(mockKeychain.get(GROUP.shared, 'oxy_shared_identity_private_key')).toBe(replaced);
  });

  it('the own index is never narrowed, and the shared one adds only organizations this device holds (R5-7)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    proveOwner(commons.KeyManager.derivePublicKey(PRIVATE));
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const c = 'cccccccccccccccccccccccc';
    const cKey = '44'.repeat(32);
    mockKeychain.put(
      GROUP.shared,
      'oxy_org_identity_index_v1',
      JSON.stringify([a, c]),
      'oxy_org_identity_index',
    );
    mockKeychain.put(
      GROUP.identity,
      'oxy_org_identity_index_v1',
      JSON.stringify([b]),
      'oxy_org_identity_index',
    );
    // This device already keeps c's pair in the wallet group; a is named only
    // by the shared copy, which any app could write.
    mockKeychain.put(GROUP.wallet, `oxy_org_identity_private_key.${c}`, cKey);
    mockKeychain.put(
      GROUP.wallet,
      `oxy_org_identity_public_key.${c}`,
      commons.KeyManager.derivePublicKey(cKey),
    );
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items['organization-index']).toBe('moved');
    expect(report.state).toBe('complete');
    expect(await commons.org.listOrganizationKeys()).toEqual([b, c]);
    expect(
      mockKeychain.get(GROUP.shared, 'oxy_org_identity_index_v1', 'oxy_org_identity_index'),
    ).toBeNull();
  });

  it('an own organization index that cannot be read is never overwritten (R5-9)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    proveOwner(commons.KeyManager.derivePublicKey(PRIVATE));
    mockKeychain.put(
      GROUP.identity,
      'oxy_org_identity_index_v1',
      '{not json',
      'oxy_org_identity_index',
    );
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items['organization-index']).toBe('failed');
    expect(report.state).toBe('incomplete');
    expect(
      mockKeychain.get(GROUP.identity, 'oxy_org_identity_index_v1', 'oxy_org_identity_index'),
    ).toBe('{not json');
    await expect(commons.org.listOrganizationKeys()).rejects.toThrow('organization key index');
    const key = await commons.org.generateOrganizationKey();
    await expect(commons.org.storeOrganizationKey(ORG, key)).rejects.toThrow(
      'organization key index',
    );
    expect(mockKeychain.get(GROUP.wallet, `oxy_org_identity_private_key.${ORG}`)).toBeNull();
    expect(
      mockKeychain.get(GROUP.identity, 'oxy_org_identity_index_v1', 'oxy_org_identity_index'),
    ).toBe('{not json');
  });

  // Exhaustive (two modes x every mutation, each with phrase derivations), so
  // it gets its own budget. Every mutation of a clean run, in turn, is where the process dies (every
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
      orgPhrase: null,
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
        // value still has a copy, and no copy anywhere holds anything else —
        // except the organization's items, which may already be gone from the
        // shared group only because its ring holds the key (R5-7), and the
        // shared index, which is never adopted.
        for (const [id, value] of snapshot) {
          const [, service, key] = id.split('|');
          const copies = Object.values(GROUP)
            .map((g) => mockKeychain.get(g, key, service === 'app' ? undefined : service))
            .filter((v) => v !== null);
          if (copies.length === 0) {
            expect(key).toMatch(/^oxy_org_identity_/);
            if (!key.startsWith('oxy_org_identity_index')) {
              expect(orgRingHolds(before.orgPrivate, before.orgPublic)).toBe(true);
            }
            continue;
          }
          expect(new Set(copies)).toEqual(new Set([value]));
        }
        // The wallet does not migrate: it reads that intermediate state as is.
        // The organization's key is either still in the shared group or
        // quarantined until Commons binds it.
        const peable = await launch(ENTITLEMENTS.wallet);
        expect(hex(await peable.KeyManager.deriveScopedSeed(LABEL))).toBe(before.seed);
        expect([before.orgSeed, null]).toContain(
          hex(await peable.KeyManager.deriveScopedSeed(LABEL, { accountId: ORG })),
        );

        const next = await launch(ENTITLEMENTS.commons);
        expect((await next.migration.ensureKeychainGroupsMigrated()).state).toBe('complete');
        expect(secretsInSharedGroup()).toEqual([]);
        await bindOrganization(next, before.orgPublic);
        expect(await commonsView(await launch(ENTITLEMENTS.commons))).toEqual(expected);
      }
    }
  }, 120_000);
});

describe('the migration adopts only what Commons provably wrote, once (R4-7)', () => {
  it('a fresh install (no sandbox marker) adopts nothing planted in the shared group, ever', async () => {
    const planted = '33'.repeat(32);
    const commons = await launch(ENTITLEMENTS.commons);
    const plantedPublic = commons.KeyManager.derivePublicKey(planted);
    for (const [key, service] of [
      ['oxy_identity_private_key_v2', 'oxy_identity'],
      ['oxy_identity_public_key_v2', 'oxy_identity'],
    ] as const) {
      mockKeychain.put(
        GROUP.shared,
        key,
        key.includes('private') ? planted : plantedPublic,
        service,
      );
    }
    mockKeychain.put(GROUP.shared, 'oxy_shared_identity_private_key', planted);
    mockKeychain.put(GROUP.shared, 'oxy_identity_mnemonic_v1', PHRASE, 'oxy_identity_mnemonic');
    const report = await commons.migration.ensureKeychainGroupsMigrated();
    expect(report).toMatchObject({
      state: 'complete',
      proven: false,
      items: { primary: 'retired', 'shared-slot': 'retired', phrase: 'retired' },
    });
    expect(await commons.KeyManager.getPrivateKey()).toBeNull();
    expect(await commons.KeyManager.getRecoveryMnemonic()).toBeNull();
    expect((await commons.KeyManager.getIdentityStatus()).state).toBe('absent');
    expect(mockKeychain.inGroup(GROUP.identity)).toEqual([
      `${GROUP.identity}|oxy_keychain_group_migration|oxy_keychain_group_migration_v1`,
    ]);
    // Nothing is adopted, and nothing is lost either (R5-3): every key is in
    // the ring QUARANTINED, out of every reader's reach, and gone from the
    // shared group.
    expect(secretsInSharedGroup()).toEqual([]);
    const ring = await import('../retiredKeys');
    expect(await ring.countQuarantinedRetiredKeys()).toBe(2);
    expect(await ring.listRetiredIdentityKeys(OWNER)).toEqual([]);

    // A later launch, even with a marker, never looks at the shared group again.
    proveOwner(plantedPublic);
    const next = await launch(ENTITLEMENTS.commons);
    expect((await next.migration.ensureKeychainGroupsMigrated()).items).toEqual({});
    expect(await next.KeyManager.getPrivateKey()).toBeNull();
    // The wallet saw Commons finish: it no longer falls back either.
    const peable = await launch(ENTITLEMENTS.wallet);
    expect(await peable.KeyManager.deriveScopedSeed(LABEL)).toBeNull();
    expect(await getPreSplitExposureOf(next)).toBeNull();
  });

  it('before Commons migrates the wallet still reads the shared group; after, never', async () => {
    await seedPreSplitCommons();
    const before = await launch(ENTITLEMENTS.wallet);
    expect(hex(await before.KeyManager.deriveScopedSeed(LABEL))).not.toBeNull();
    await (await launch(ENTITLEMENTS.commons)).migration.ensureKeychainGroupsMigrated();
    mockKeychain.put(
      GROUP.shared,
      'oxy_org_identity_private_key.cccccccccccccccccccccccc',
      '44'.repeat(32),
    );
    const after = await launch(ENTITLEMENTS.wallet);
    await after.KeyManager.deriveScopedSeed(LABEL);
    expect(await after.org.getOrganizationPrivateKey('cccccccccccccccccccccccc')).toBeNull();
  });

  it('a Commons secret write deletes any copy left in the shared group (R4-6)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    await commons.migration.ensureKeychainGroupsMigrated();
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', '55'.repeat(32), 'oxy_identity');
    mockKeychain.put(GROUP.shared, 'oxy_shared_identity_private_key', '55'.repeat(32));
    await commons.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    expect(await commons.KeyManager.syncSharedIdentity()).toBe(true);
    expect(
      mockKeychain.get(GROUP.shared, 'oxy_identity_private_key_v2', 'oxy_identity'),
    ).toBeNull();
    expect(mockKeychain.get(GROUP.shared, 'oxy_shared_identity_private_key')).toBeNull();
  });

  it('records that the identity sat in the shared group, for a rotation recommendation', async () => {
    const before = await seedPreSplitCommons();
    const commons = await launch(ENTITLEMENTS.commons);
    expect((await commons.migration.ensureKeychainGroupsMigrated()).proven).toBe(true);
    expect(await getPreSplitExposureOf(commons)).toEqual({
      publicKey: before.publicKey,
      organizations: [ORG],
    });
  });

  it('only Commons writes the retired ring; the wallet only reads it (R4-14)', async () => {
    const peable = await launch(ENTITLEMENTS.wallet);
    const ring = await import('../retiredKeys');
    const key = '66'.repeat(32);
    await expect(
      ring.retireIdentityKey(
        {
          privateKey: key,
          publicKey: peable.KeyManager.derivePublicKey(key),
        },
        OWNER,
      ),
    ).rejects.toThrow('only Commons');
    expect(mockKeychain.inGroup(GROUP.wallet)).toEqual([]);
  });

  it('a development build keeps its secrets in its own .dev groups (R4-14)', async () => {
    const dev = await launch([`${GROUP.identity}.dev`, `${GROUP.wallet}.dev`, GROUP.shared]);
    await dev.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    expect(await dev.KeyManager.syncSharedIdentity()).toBe(true);
    expect(mockKeychain.inGroup(GROUP.identity)).toEqual([]);
    expect(mockKeychain.inGroup(GROUP.wallet)).toEqual([]);
    expect(
      mockKeychain.get(`${GROUP.identity}.dev`, 'oxy_identity_private_key_v2', 'oxy_identity'),
    ).toBe(PRIVATE);
    expect(mockKeychain.get(`${GROUP.wallet}.dev`, 'oxy_shared_identity_private_key')).toBe(
      PRIVATE,
    );
  });
});

async function getPreSplitExposureOf(_l: Launch) {
  return (await import('../keychainGroupMigration')).getPreSplitExposure();
}

describe('round 5: nothing in the shared group is lost, trusted or prompted for', () => {
  const ORG_KEY = '88'.repeat(32);

  it('a device without a marker keeps every shared key and phrase quarantined, then deletes it (R5-3)', async () => {
    const before = await seedPreSplitCommons();
    sandbox.clear(); // a reinstall: Commons' sandbox marker is gone, the keychain is not
    const commons = await launch(ENTITLEMENTS.commons);
    const report = await commons.migration.ensureKeychainGroupsMigrated();
    expect(report).toMatchObject({ state: 'complete', proven: false });
    expect(secretsInSharedGroup()).toEqual([]);
    expect(await commons.KeyManager.getPrivateKey()).toBeNull();
    // Personal: reachable only once the account's key history names it.
    const ring = await import('../retiredKeys');
    expect(await ring.listRetiredIdentityKeys(OWNER)).toEqual([]);
    await expect(
      ring.claimRetiredIdentityKeys(OWNER.ownerAccountId, [before.publicKey]),
    ).resolves.toBe(1);
    expect((await ring.listRetiredIdentityKeys(OWNER)).map((k) => k.publicKey)).toEqual([
      before.publicKey,
    ]);
    // Organization: quarantined in its own ring until its history names it.
    expect(orgRingHolds(before.orgPrivate, before.orgPublic)).toBe(true);
    expect(await ring.listRetiredIdentityKeys({ accountId: ORG })).toEqual([]);
    await expect(ring.claimRetiredOrganizationKeys(ORG, ['04'.padEnd(130, '1')])).resolves.toBe(0);
    await bindOrganization(commons, before.orgPublic);
    expect(await commons.org.getOrganizationPrivateKey(ORG)).toBe(before.orgPrivate);
  });

  it('a Commons secret write keeps a different shared copy quarantined before deleting it (R5-3)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    await commons.migration.ensureKeychainGroupsMigrated();
    const other = '55'.repeat(32);
    const otherPublic = commons.KeyManager.derivePublicKey(other);
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', other, 'oxy_identity');
    mockKeychain.put(GROUP.shared, `oxy_org_identity_private_key.${ORG}`, ORG_KEY);
    await commons.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    await commons.org.storeOrganizationKey(ORG, {
      privateKey: '99'.repeat(32),
      publicKey: commons.KeyManager.derivePublicKey('99'.repeat(32)),
    });
    expect(
      mockKeychain.get(GROUP.shared, 'oxy_identity_private_key_v2', 'oxy_identity'),
    ).toBeNull();
    expect(mockKeychain.get(GROUP.shared, `oxy_org_identity_private_key.${ORG}`)).toBeNull();
    expect(
      mockKeychain.get(GROUP.wallet, `oxy_retired_identity_private_key.personal.${otherPublic}`),
    ).toBe(other);
    expect(orgRingHolds(ORG_KEY, commons.KeyManager.derivePublicKey(ORG_KEY))).toBe(true);
    const ring = await import('../retiredKeys');
    expect(await ring.listRetiredIdentityKeys({ accountId: ORG })).toEqual([]);
  });

  it('a write whose different shared copy cannot be kept fails and changes nothing (R5-3)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    await commons.migration.ensureKeychainGroupsMigrated();
    const other = '55'.repeat(32);
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', other, 'oxy_identity');
    mockKeychain.failWrites.add(
      `${GROUP.wallet}|oxy_retired_identity_private_key.personal.${commons.KeyManager.derivePublicKey(other)}`,
    );
    await expect(commons.KeyManager.importKeyPair(PRIVATE, { overwrite: true })).rejects.toThrow();
    expect(mockKeychain.get(GROUP.shared, 'oxy_identity_private_key_v2', 'oxy_identity')).toBe(
      other,
    );
    expect(
      mockKeychain.get(GROUP.identity, 'oxy_identity_private_key_v2', 'oxy_identity'),
    ).toBeNull();
  });

  it('a shared copy equal to the value written is simply deleted', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    await commons.migration.ensureKeychainGroupsMigrated();
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', PRIVATE, 'oxy_identity');
    await commons.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    expect(
      mockKeychain.get(GROUP.shared, 'oxy_identity_private_key_v2', 'oxy_identity'),
    ).toBeNull();
    expect(mockKeychain.inGroup(GROUP.wallet).some((id) => id.includes('retired'))).toBe(false);
  });

  it('a development build never reads, moves or deletes anything in the shared group (R5-5)', async () => {
    await seedPreSplitCommons();
    const snapshot = new Map(mockKeychain.items);
    const shared = mockKeychain.inGroup(GROUP.shared);
    proveOwner(mockKeychain.get(GROUP.shared, 'oxy_shared_identity_public_key') ?? '');
    const dev = await launch([`${GROUP.identity}.dev`, `${GROUP.wallet}.dev`, GROUP.shared]);
    mockKeychain.calls.length = 0;
    const report = await dev.migration.ensureKeychainGroupsMigrated();
    expect(report.state).toBe('not-applicable');
    expect(await dev.KeyManager.getPrivateKey()).toBeNull();
    expect(await dev.KeyManager.getRecoveryMnemonic()).toBeNull();
    expect(await dev.org.getOrganizationPrivateKey(ORG)).toBeNull();
    // Writing its own identity leaves production's copies where they are.
    await dev.KeyManager.importKeyPair('12'.repeat(32), { overwrite: true });
    await dev.KeyManager.deleteIdentity({ force: true } as never).catch(() => undefined);
    expect(mockKeychain.inGroup(GROUP.shared)).toEqual(shared);
    for (const id of shared) expect(mockKeychain.items.get(id)).toBe(snapshot.get(id));
    expect(
      mockKeychain.calls.some(
        (c) => c.options.accessGroup === GROUP.shared && /private_key|mnemonic/.test(c.key),
      ),
    ).toBe(false);
  });

  it('an organization copy equal to the key this device holds is adopted (R5-7)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    proveOwner(commons.KeyManager.derivePublicKey(PRIVATE));
    const orgPublic = commons.KeyManager.derivePublicKey(ORG_KEY);
    mockKeychain.put(
      GROUP.shared,
      'oxy_org_identity_index_v1',
      JSON.stringify([ORG]),
      'oxy_org_identity_index',
    );
    mockKeychain.put(GROUP.shared, `oxy_org_identity_private_key.${ORG}`, ORG_KEY);
    mockKeychain.put(GROUP.wallet, `oxy_org_identity_private_key.${ORG}`, ORG_KEY);
    const report = await commons.migration.runKeychainGroupMigration();
    expect(report.items['organization-1']).toBe('moved');
    expect(mockKeychain.get(GROUP.wallet, `oxy_org_identity_public_key.${ORG}`)).toBe(orgPublic);
    expect(await commons.org.listOrganizationKeys()).toEqual([ORG]);
    expect(orgRingHolds(ORG_KEY, orgPublic)).toBe(false);
  });

  it('reads the shared group without user interaction, never the Face ID copy (R5-9)', async () => {
    await seedPreSplitCommons();
    mockNoInteraction = true;
    const commons = await launch(ENTITLEMENTS.commons);
    mockKeychain.calls.length = 0;
    expect((await commons.migration.ensureKeychainGroupsMigrated()).state).toBe('complete');
    // Every shared read went through the no-interaction reader…
    expect(mockNoInteractionReads.length).toBeGreaterThan(0);
    expect(
      mockKeychain.calls.some((c) => c.op === 'get' && c.options.accessGroup === GROUP.shared),
    ).toBe(false);
    // …and so does a write's look at the shared copy.
    mockKeychain.calls.length = 0;
    await commons.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    expect(
      mockKeychain.calls.some((c) => c.op === 'get' && c.options.accessGroup === GROUP.shared),
    ).toBe(false);
  });

  it('an incomplete run opens the fallback only for the items that failed, and retries later (R5-9)', async () => {
    await seedPreSplitCommons();
    mockKeychain.failWrites.add(`${GROUP.identity}|oxy_identity_mnemonic_v1`);
    const commons = await launch(ENTITLEMENTS.commons);
    const report = await commons.migration.ensureKeychainGroupsMigrated();
    expect(report.state).toBe('incomplete');
    expect(report.items.phrase).toBe('failed');
    // The proven phrase that could not move is still readable…
    expect(await commons.KeyManager.getRecoveryMnemonic()).toBe(PHRASE);
    // …but no other shared copy is: one planted now is not read.
    mockKeychain.put(
      GROUP.shared,
      'oxy_identity_backup_private_key_v2',
      '13'.repeat(32),
      'oxy_identity_backup',
    );
    mockKeychain.calls.length = 0;
    await commons.KeyManager.getRecoveryMnemonic();
    const sharedGets = mockKeychain.calls.filter(
      (c) => c.op === 'get' && c.options.accessGroup === GROUP.shared,
    );
    expect(sharedGets.map((c) => c.key)).toEqual(['oxy_identity_mnemonic_v1']);

    // Before the backoff, the report stands; after it, a later access retries.
    mockKeychain.failWrites.clear();
    expect((await commons.migration.ensureKeychainGroupsMigrated()).state).toBe('incomplete');
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    try {
      expect((await commons.migration.ensureKeychainGroupsMigrated()).state).toBe('complete');
    } finally {
      clock.mockRestore();
    }
    expect(secretsInSharedGroup()).toEqual([]);
    expect(await commons.KeyManager.getRecoveryMnemonic()).toBe(PHRASE);
  });
});

describe('a money holder learns its public key from the private key it spends (R5-1)', () => {
  const ATTACKER = '77'.repeat(32);

  it("a public key planted in the shared group is never the wallet's", async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const mine = commons.KeyManager.derivePublicKey(PRIVATE);
    const planted = commons.KeyManager.derivePublicKey(ATTACKER);
    mockKeychain.put(GROUP.wallet, 'oxy_shared_identity_private_key', PRIVATE);
    mockKeychain.put(GROUP.shared, 'oxy_shared_identity_public_key', planted);

    const peable = await launch(ENTITLEMENTS.wallet);
    await expect(peable.KeyManager.getIdentityPublicKeyForMoney()).resolves.toBe(mine);
    await expect(peable.KeyManager.getSharedPublicKey()).resolves.toBe(mine);
    await expect(peable.KeyManager.getIdentityKeyState()).resolves.toMatchObject({
      activePublicKey: mine,
    });
    // The key it shows is the key it spends.
    expect(hex(await peable.KeyManager.deriveScopedSeed(LABEL))).toBe(
      hex(deriveScopedSeedFromKey(PRIVATE, LABEL)),
    );

    // No private key: no public key either, never the planted one.
    await mockKeychain.deleteItemAsync('oxy_shared_identity_private_key', {
      accessGroup: GROUP.wallet,
    });
    const empty = await launch(ENTITLEMENTS.wallet);
    await expect(empty.KeyManager.getIdentityPublicKeyForMoney()).resolves.toBeNull();
    await expect(empty.KeyManager.getSharedPublicKey()).resolves.toBeNull();

    // Any other app holds no money key; it still reads the public item.
    const member = await launch(ENTITLEMENTS.member);
    await expect(member.KeyManager.getIdentityPublicKeyForMoney()).resolves.toBeNull();
    await expect(member.KeyManager.getSharedPublicKey()).resolves.toBe(planted);
  });

  it("an organization's key is derived from its pair in the wallet group", async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const orgKey = '55'.repeat(32);
    mockKeychain.put(GROUP.wallet, `oxy_org_identity_private_key.${ORG}`, orgKey);
    mockKeychain.put(
      GROUP.wallet,
      `oxy_org_identity_public_key.${ORG}`,
      commons.KeyManager.derivePublicKey(orgKey),
    );
    const peable = await launch(ENTITLEMENTS.wallet);
    await expect(peable.KeyManager.getIdentityPublicKeyForMoney({ accountId: ORG })).resolves.toBe(
      commons.KeyManager.derivePublicKey(orgKey),
    );
    // A pair whose public half was swapped is no key at all.
    mockKeychain.put(
      GROUP.wallet,
      `oxy_org_identity_public_key.${ORG}`,
      commons.KeyManager.derivePublicKey(ATTACKER),
    );
    const again = await launch(ENTITLEMENTS.wallet);
    await expect(
      again.KeyManager.getIdentityPublicKeyForMoney({ accountId: ORG }),
    ).resolves.toBeNull();
    await expect(
      again.KeyManager.getIdentityPublicKeyForMoney({ accountId: 'not-an-id' }),
    ).resolves.toBeNull();
  });
});

describe('round 6: a v1 record is swept again; the ring is bounded and never in the shared group', () => {
  const ORG_KEY = '88'.repeat(32);
  const RECORD = ['oxy_keychain_group_migration_v1', 'oxy_keychain_group_migration'] as const;
  const record = () => {
    const raw = mockKeychain.get(GROUP.identity, RECORD[0], RECORD[1]);
    return raw ? (JSON.parse(raw) as { v: number; revalidate?: string[] }) : null;
  };
  /** What core 7.32 left on a phone: a v1 record, and the shared copies it never swept. */
  function leftByCore732(commons: Launch) {
    mockKeychain.put(
      GROUP.identity,
      RECORD[0],
      JSON.stringify({ v: 1, completedAt: 1 }),
      RECORD[1],
    );
    mockKeychain.put(GROUP.wallet, RECORD[0], JSON.stringify({ v: 1, completedAt: 1 }), RECORD[1]);
    const planted = '33'.repeat(32);
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', planted, 'oxy_identity');
    mockKeychain.put(GROUP.shared, 'oxy_identity_mnemonic_v1', PHRASE, 'oxy_identity_mnemonic');
    // An organization pair 7.32 adopted with no provenance: live in the wallet group.
    mockKeychain.put(GROUP.wallet, `oxy_org_identity_private_key.${ORG}`, ORG_KEY);
    mockKeychain.put(
      GROUP.wallet,
      `oxy_org_identity_public_key.${ORG}`,
      commons.KeyManager.derivePublicKey(ORG_KEY),
    );
    mockKeychain.put(
      GROUP.identity,
      'oxy_org_identity_index_v1',
      JSON.stringify([ORG]),
      'oxy_org_identity_index',
    );
    return { planted, plantedPublic: commons.KeyManager.derivePublicKey(planted) };
  }

  it('a v1 record does not end the migration: the shared group is swept and held organizations re-validated (R6-3)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const { planted, plantedPublic } = leftByCore732(commons);
    const report = await commons.migration.ensureKeychainGroupsMigrated();
    expect(report).toMatchObject({
      state: 'complete',
      proven: false,
      items: { primary: 'retired', phrase: 'retired' },
    });
    expect(secretsInSharedGroup()).toEqual([]);
    // Kept, quarantined: nobody reaches it until a key history names it.
    expect(
      mockKeychain.get(GROUP.wallet, `oxy_retired_identity_private_key.personal.${plantedPublic}`),
    ).toBe(planted);
    const ring = await import('../retiredKeys');
    expect(await ring.listRetiredIdentityKeys(OWNER)).toEqual([]);
    expect(record()).toMatchObject({ v: 2, revalidate: [ORG] });
    expect(await commons.migration.pendingOrganizationRevalidation()).toEqual([ORG]);

    // A v2 record is final: the next launch looks at nothing.
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', '44'.repeat(32), 'oxy_identity');
    const next = await launch(ENTITLEMENTS.commons);
    expect((await next.migration.ensureKeychainGroupsMigrated()).items).toEqual({});
  });

  it('a held organization pair the organization does not publish is quarantined, then bound by its history (R6-3)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    leftByCore732(commons);
    await commons.migration.ensureKeychainGroupsMigrated();
    const orgPublic = commons.KeyManager.derivePublicKey(ORG_KEY);
    const published = commons.KeyManager.derivePublicKey('99'.repeat(32));
    await expect(
      commons.org.revalidateHeldOrganizationKeys(async () => ({ publicKey: published })),
    ).resolves.toBe(1);
    // No live pair: the wallet derives nothing from it.
    expect(await commons.org.getOrganizationPrivateKey(ORG)).toBeNull();
    expect(await commons.org.listOrganizationKeys()).toEqual([]);
    expect(orgRingHolds(ORG_KEY, orgPublic)).toBe(true);
    const ring = await import('../retiredKeys');
    expect(await ring.listQuarantinedOrganizationKeys()).toEqual([
      { accountId: ORG, publicKey: orgPublic },
    ]);
    expect(await commons.migration.pendingOrganizationRevalidation()).toEqual([]);
    // The organization's history names it (a previous key): bound, spendable.
    await expect(ring.claimRetiredOrganizationKeys(ORG, [published, orgPublic])).resolves.toBe(1);
    expect(
      (await ring.listRetiredIdentityKeys({ accountId: ORG })).map((k) => k.publicKey),
    ).toEqual([orgPublic]);
  });

  it('a held pair equal to the published key stays live; an unreadable organization stays pending (R6-3)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    leftByCore732(commons);
    await commons.migration.ensureKeychainGroupsMigrated();
    await expect(
      commons.org.revalidateHeldOrganizationKeys(async () => {
        throw new Error('forbidden');
      }),
    ).resolves.toBe(0);
    expect(await commons.migration.pendingOrganizationRevalidation()).toEqual([ORG]);
    await expect(
      commons.org.revalidateHeldOrganizationKeys(async () => ({
        publicKey: commons.KeyManager.derivePublicKey(ORG_KEY),
      })),
    ).resolves.toBe(0);
    expect(await commons.org.getOrganizationPrivateKey(ORG)).toBe(ORG_KEY);
    expect(await commons.migration.pendingOrganizationRevalidation()).toEqual([]);
  });

  it('a full quarantine never stops re-validation: a held pair is kept past the bound (R7-5)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    leftByCore732(commons);
    await commons.migration.ensureKeychainGroupsMigrated();
    const ring = await import('../retiredKeys');
    // A flood from the shared group filled this organization's quarantine.
    for (let i = 0; i < ring.MAX_QUARANTINED_RING_ENTRIES; i += 1) {
      const key = (i + 1).toString(16).padStart(64, '0');
      await ring.quarantineRetiredIdentityKey(
        { privateKey: key, publicKey: commons.KeyManager.derivePublicKey(key) },
        { accountId: ORG },
      );
    }
    const published = commons.KeyManager.derivePublicKey('99'.repeat(32));
    await expect(
      commons.org.revalidateHeldOrganizationKeys(async () => ({ publicKey: published })),
    ).resolves.toBe(1);
    expect(orgRingHolds(ORG_KEY, commons.KeyManager.derivePublicKey(ORG_KEY))).toBe(true);
    expect(await commons.org.getOrganizationPrivateKey(ORG)).toBeNull();
    expect(await commons.migration.pendingOrganizationRevalidation()).toEqual([]);
  });

  it('planted ids with no held pair settle with no network read; reads per launch are bounded (R7-11)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const invented = Array.from({ length: 200 }, (_, i) => (i + 1).toString(16).padStart(24, 'a'));
    const held = Array.from({ length: 20 }, (_, i) => (i + 1).toString(16).padStart(24, 'b'));
    for (const [i, accountId] of held.entries()) {
      const key = (i + 1).toString(16).padStart(64, 'c');
      mockKeychain.put(GROUP.wallet, `oxy_org_identity_private_key.${accountId}`, key);
      mockKeychain.put(
        GROUP.wallet,
        `oxy_org_identity_public_key.${accountId}`,
        commons.KeyManager.derivePublicKey(key),
      );
    }
    const v2 = JSON.stringify({ v: 2, completedAt: 1, revalidate: [...invented, ...held].sort() });
    mockKeychain.put(GROUP.identity, RECORD[0], v2, RECORD[1]);
    mockKeychain.put(GROUP.wallet, RECORD[0], v2, RECORD[1]);
    const next = await launch(ENTITLEMENTS.commons);
    const reads: string[] = [];
    const answer = async (accountId: string) => {
      reads.push(accountId);
      const index = held.indexOf(accountId);
      return {
        publicKey: next.KeyManager.derivePublicKey((index + 1).toString(16).padStart(64, 'c')),
      };
    };
    await expect(next.org.revalidateHeldOrganizationKeys(answer)).resolves.toBe(0);
    expect(reads.every((id) => held.includes(id))).toBe(true);
    expect(reads).toHaveLength(next.org.MAX_REVALIDATIONS_PER_LAUNCH);
    // Only the held ones the bound left over still wait.
    const pending = await next.migration.pendingOrganizationRevalidation();
    expect(pending).toHaveLength(held.length - next.org.MAX_REVALIDATIONS_PER_LAUNCH);
    expect(pending.every((id) => held.includes(id))).toBe(true);
    await next.org.revalidateHeldOrganizationKeys(answer);
    expect(await next.migration.pendingOrganizationRevalidation()).toEqual([]);
  });

  it('the bound is per ring, exempt keys pass it, and entries with no private half are purged (R7-5)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const ring = await import('../retiredKeys');
    const pair = (n: number) => {
      const key = n.toString(16).padStart(64, '0');
      return { privateKey: key, publicKey: commons.KeyManager.derivePublicKey(key) };
    };
    for (let i = 1; i <= ring.MAX_QUARANTINED_RING_ENTRIES; i += 1) {
      await ring.quarantineRetiredIdentityKey(pair(i));
    }
    const overflow = pair(ring.MAX_QUARANTINED_RING_ENTRIES + 1);
    await expect(ring.quarantineRetiredIdentityKey(overflow)).rejects.toBeInstanceOf(
      ring.RetiredKeyQuarantineFullError,
    );
    // Another ring is not refused by this one's flood.
    await expect(
      ring.quarantineRetiredIdentityKey(pair(500), { accountId: ORG }),
    ).resolves.toBeUndefined();
    // A key this device held itself is kept past the bound.
    await expect(
      ring.quarantineRetiredIdentityKey(pair(501), undefined, { exempt: true }),
    ).resolves.toBeUndefined();
    // Entries whose private half is gone hold nothing: purged to make room
    // (two: the exempt key counts too).
    for (const n of [1, 2]) {
      await mockKeychain.deleteItemAsync(
        `oxy_retired_identity_private_key.personal.${pair(n).publicKey}`,
        { accessGroup: GROUP.wallet },
      );
    }
    await expect(ring.quarantineRetiredIdentityKey(overflow)).resolves.toBeUndefined();
    const left = await ring.listQuarantinedIdentityKeys();
    expect(left).not.toContain(pair(1).publicKey);
    expect(left).toContain(pair(3).publicKey);
  });

  it('the wallet never reads a ring item from the shared group, even before Commons migrated (R6-12)', async () => {
    const key = '21'.repeat(32);
    const peable = await launch(ENTITLEMENTS.wallet);
    const publicKey = peable.KeyManager.derivePublicKey(key);
    mockKeychain.put(
      GROUP.shared,
      'oxy_retired_identity_index_v1',
      JSON.stringify([{ scope: ORG, publicKey, retiredAt: 1 }]),
    );
    mockKeychain.put(GROUP.shared, `oxy_retired_identity_private_key.${ORG}.${publicKey}`, key);
    // The wallet's pre-migration fallback is open for the current keys…
    mockKeychain.put(GROUP.shared, `oxy_org_identity_private_key.${ORG}`, ORG_KEY);
    expect(await peable.org.getOrganizationPrivateKey(ORG)).toBeNull(); // no public half: no pair
    // …never for the ring.
    const ring = await import('../retiredKeys');
    expect(await ring.listRetiredIdentityKeys({ accountId: ORG })).toEqual([]);
    expect(
      hex(await peable.KeyManager.deriveScopedSeed(LABEL, { accountId: ORG, publicKey })),
    ).toBeNull();
    expect(
      mockKeychain.calls.some(
        (c) => c.options.accessGroup === GROUP.shared && c.key.startsWith('oxy_retired_identity'),
      ),
    ).toBe(false);
  });

  it('a planted shared index is looked at only up to the bound (R6-14)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const planted = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(24, '0'));
    mockKeychain.put(
      GROUP.shared,
      'oxy_org_identity_index_v1',
      JSON.stringify(planted),
      'oxy_org_identity_index',
    );
    const report = await commons.migration.runKeychainGroupMigration();
    const organizations = Object.keys(report.items).filter((label) =>
      /^organization-\d+$/.test(label),
    );
    expect(organizations).toHaveLength(commons.migration.MAX_MIGRATION_ORGANIZATIONS);
  });

  it('the quarantine is bounded: past it a shared key is LEFT where it is and the run still settles (R6-14)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const ring = await import('../retiredKeys');
    for (let i = 0; i < ring.MAX_QUARANTINED_RING_ENTRIES; i += 1) {
      const key = (i + 1).toString(16).padStart(64, '0');
      await ring.quarantineRetiredIdentityKey({
        privateKey: key,
        publicKey: commons.KeyManager.derivePublicKey(key),
      });
    }
    const extra = 'fe'.repeat(32);
    mockKeychain.put(GROUP.shared, 'oxy_identity_private_key_v2', extra, 'oxy_identity');
    // A phone whose migration has not run yet (its record is not there).
    for (const group of [GROUP.identity, GROUP.wallet]) {
      await mockKeychain.deleteItemAsync(RECORD[0], {
        accessGroup: group,
        keychainService: RECORD[1],
      });
    }
    const next = await launch(ENTITLEMENTS.commons);
    const report = await next.migration.ensureKeychainGroupsMigrated();
    expect(report.state).toBe('complete');
    expect(report.items.primary).toBe('over-limit');
    expect(mockKeychain.get(GROUP.shared, 'oxy_identity_private_key_v2', 'oxy_identity')).toBe(
      extra,
    );
    expect(await ring.countQuarantinedRetiredKeys()).toBe(ring.MAX_QUARANTINED_RING_ENTRIES);
    await expect(
      ring.quarantineRetiredIdentityKey({
        privateKey: extra,
        publicKey: commons.KeyManager.derivePublicKey(extra),
      }),
    ).rejects.toBeInstanceOf(ring.RetiredKeyQuarantineFullError);
  });

  it('a development Commons writes no public key into the production shared group', async () => {
    const dev = await launch([`${GROUP.identity}.dev`, `${GROUP.wallet}.dev`, GROUP.shared]);
    await dev.KeyManager.importKeyPair(PRIVATE, { overwrite: true });
    expect(await dev.KeyManager.syncSharedIdentity()).toBe(true);
    expect(mockKeychain.inGroup(GROUP.shared)).toEqual([]);
    // It still knows its own key, from the private key it holds.
    await expect(dev.KeyManager.getSharedPublicKey()).resolves.toBe(
      dev.KeyManager.derivePublicKey(PRIVATE),
    );
  });

  it('only a quarantined personal key signs a claim, and the key never leaves the ring (R6-5)', async () => {
    const commons = await launch(ENTITLEMENTS.commons);
    const ring = await import('../retiredKeys');
    const key = '31'.repeat(32);
    const publicKey = commons.KeyManager.derivePublicKey(key);
    await ring.quarantineRetiredIdentityKey({ privateKey: key, publicKey });
    expect(await ring.listQuarantinedIdentityKeys()).toEqual([publicKey]);
    const signature = await ring.signWithQuarantinedIdentityKey(publicKey, 'claim');
    const { verifySignature } = await import('@oxy.so/protocol/sign');
    expect(signature).not.toBeNull();
    expect(await verifySignature('claim', signature as string, publicKey)).toBe(true);
    // Once bound to its owner it no longer signs claims.
    await ring.claimRetiredIdentityKeys(OWNER.ownerAccountId, [publicKey]);
    expect(await ring.signWithQuarantinedIdentityKey(publicKey, 'claim')).toBeNull();
    expect(await ring.listQuarantinedIdentityKeys()).toEqual([]);
  });
});
