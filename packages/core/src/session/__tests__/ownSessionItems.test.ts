/**
 * On iOS each app's session store is its own (ADR 0062 D6), against a keychain
 * fake with Apple's group semantics shared by several apps.
 *
 * Every Oxy app writes its session under the SAME names (`oxy.auth.v1`, the
 * warm token, the sign-out marker, the identity pin). Before the app group, an
 * item written without a group landed in the app's default group — the shared
 * group for every app but Commons and the Peable wallet — so those apps read and
 * overwrote ONE session, and every app read Commons' vault session from before
 * the split. The adapter below makes the three calls `@oxy.so/services`'
 * `nativeSecureStorage.ts` makes (its own test pins them).
 *
 * A "launch" is a fresh module graph over the SAME keychain with one app's
 * entitlements and native build:
 * - `fixed`: the default-group probe and the application-group probe;
 * - `split`: the default-group probe only (services 14.8.0 to 14.9.0);
 * - `preSplit`: neither, every app in the shared group alone.
 */
import { APP, ENTITLEMENTS, FakeKeychain, GROUP } from '../../crypto/__tests__/fakeKeychain';
import type { NativeKeyValueStorage, PersistedAuthState } from '../authStateStore';

const mockKeychain = new FakeKeychain();
const mockProbes = { default: true, application: true };

jest.mock('@oxy.so/protocol', () => ({
  __esModule: true,
  ...jest.requireActual('@oxy.so/protocol'),
  loadKeychainDefaultAccessGroup: async () =>
    mockProbes.default ? mockKeychain.probe() : { state: 'unsupported' },
  loadKeychainApplicationAccessGroup: async (prefix: string) =>
    mockProbes.application ? mockKeychain.applicationProbe(prefix) : { state: 'unsupported' },
}));

type AppName = keyof typeof APP;
type Build = 'fixed' | 'split' | 'preSplit';

const ENTITLED: Record<AppName, string[]> = {
  commons: ENTITLEMENTS.commons,
  wallet: ENTITLEMENTS.wallet,
  mention: ENTITLEMENTS.member,
  alia: ENTITLEMENTS.member,
};

const DURABLE = 'oxy.auth.v1';
const WARM = 'oxy.auth.token.v1';
const MARKER = 'oxy.auth.automatic-identity-signin-suppressed.v1';
const PIN = 'oxy.identity.pin.v1';

const state = (who: string): PersistedAuthState => ({
  sessionId: `session-${who}`,
  userId: `user-${who}`,
  deviceId: `device-${who}`,
  deviceSecret: `secret-${who}`,
  accessToken: `token-${who}`,
  expiresAt: '2099-01-01T00:00:00.000Z',
});

/** `refused`: a keychain that does not let the app name its own group. */
async function launch(app: AppName, build: Build = 'fixed', refused = false) {
  jest.resetModules();
  mockKeychain.entitlements = [...(build === 'preSplit' ? ENTITLEMENTS.preSplit : ENTITLED[app])];
  mockKeychain.application = refused ? null : APP[app];
  mockProbes.default = build !== 'preSplit';
  mockProbes.application = build === 'fixed';
  (await import('../../utils/platform')).setPlatformOS('ios');
  const groups = await import('../../utils/keychainAccessGroups');
  const auth = await import('../authStateStore');
  const pins = await import('../identityPin');
  const plan = async (key: string) =>
    groups.ownKeychainItemPlan(
      await groups.resolveKeychainAccess(),
      auth.nativeSessionItemNames(key),
    );
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => groups.readThroughPlan(mockKeychain, key, {}, (await plan(key)).read),
    setItem: async (key, value) => mockKeychain.setItemAsync(key, value, (await plan(key)).write),
    removeItem: async (key) =>
      groups.deleteThroughPlan(mockKeychain, key, {}, (await plan(key)).delete),
  };
  return {
    store: auth.createNativeAuthStateStore(storage),
    pins: pins.createNativeIdentityPinStore(storage),
    access: () => groups.resolveKeychainAccess(),
  };
}

/** A session as an earlier build wrote it, straight into `group`. */
function seed(group: string, who: string): PersistedAuthState {
  const s = state(who);
  const { accessToken, expiresAt, ...durable } = s;
  mockKeychain.put(group, DURABLE, JSON.stringify(durable));
  mockKeychain.put(group, WARM, JSON.stringify({ accessToken, expiresAt }));
  return s;
}

const sessionItemsIn = (group: string) =>
  mockKeychain.inGroup(group).filter((id) => id.includes('|oxy.'));

beforeEach(() => {
  mockKeychain.items.clear();
  mockKeychain.locked = false;
  mockKeychain.failMutationAt = null;
  mockKeychain.mutations = 0;
  mockKeychain.failWrites.clear();
  mockKeychain.corruptWrites.clear();
  mockKeychain.calls.length = 0;
});

describe('the defect: one session item for every app but Commons and the wallet', () => {
  it('a build without the application-group probe still shares it (fixed by its next native build)', async () => {
    const mention = await launch('mention', 'split');
    expect(await mention.store.save(state('mention'))).toBe(true);
    const alia = await launch('alia', 'split');
    // Alia boots into Mention's session, and its sign-out signs Mention out.
    expect((await alia.store.load())?.sessionId).toBe('session-mention');
    await alia.store.clear();
    expect(await (await launch('mention', 'split')).store.load()).toBeNull();
  });
});

describe('each app keeps its own session (ADR 0062 D6)', () => {
  it('resolves the application group, and only from the probe that proved it', async () => {
    expect(await (await launch('mention')).access()).toMatchObject({
      role: 'member',
      appGroup: APP.mention,
    });
    expect(await (await launch('commons')).access()).toMatchObject({
      role: 'holder',
      appGroup: APP.commons,
    });
    expect(await (await launch('mention', 'split')).access()).not.toHaveProperty('appGroup');
  });

  it('two apps never read, overwrite or clear each other', async () => {
    const all: AppName[] = ['commons', 'wallet', 'mention', 'alia'];
    for (const app of all) {
      expect(await (await launch(app)).store.save(state(app))).toBe(true);
    }
    for (const app of all) {
      expect(await (await launch(app)).store.load()).toEqual(state(app));
    }
    await (await launch('alia')).store.clear();
    expect(await (await launch('alia')).store.load()).toBeNull();
    for (const app of ['commons', 'wallet', 'mention'] as const) {
      expect(await (await launch(app)).store.load()).toEqual(state(app));
    }
    // Nothing of any app's session went to a group another app can read.
    expect(sessionItemsIn(GROUP.shared)).toEqual([]);
    expect(sessionItemsIn(GROUP.wallet)).toEqual([]);
    expect(sessionItemsIn(GROUP.identity)).toEqual([]);
    expect(sessionItemsIn(APP.mention)).toHaveLength(2);
    expect(sessionItemsIn(APP.alia)).toEqual([]);
  });

  it('never adopts the shared copy: it may be another app’s session or Commons’ vault', async () => {
    // Before the split, Commons (identity mode) and every member wrote here.
    const vault = seed(GROUP.shared, 'commons-vault');
    mockKeychain.put(GROUP.shared, PIN, JSON.stringify({ publicKey: '04ab', accountId: 'x' }));
    const mention = await launch('mention');
    expect(await mention.store.load()).toBeNull();
    const commons = await launch('commons');
    expect(await commons.store.load()).toBeNull();
    expect(await commons.pins.load()).toBeNull();
    // Saving and signing out here leaves the shared copy to the apps whose
    // build still uses it: upgrading one app signs no other app out.
    await mention.store.save(state('mention'));
    await mention.store.clear();
    const stillOld = await launch('alia', 'split');
    expect(await stillOld.store.load()).toEqual(vault);
  });

  it('Commons and the wallet keep the session the split put in their default group', async () => {
    seed(GROUP.shared, 'someone-else');
    const commonsSplit = await launch('commons', 'split');
    expect(await commonsSplit.store.save(state('commons-f5'))).toBe(true);
    const walletSplit = await launch('wallet', 'split');
    expect(await walletSplit.store.save(state('wallet-f5'))).toBe(true);
    expect(sessionItemsIn(GROUP.identity)).toHaveLength(2);
    expect(sessionItemsIn(GROUP.wallet)).toHaveLength(2);

    // The fixed build signs nobody out: it reads that copy...
    const commons = await launch('commons');
    expect(await commons.store.load()).toEqual(state('commons-f5'));
    const wallet = await launch('wallet');
    expect(await wallet.store.load()).toEqual(state('wallet-f5'));
    // ...and its next write wins over it.
    await (await launch('commons')).store.save(state('commons-new'));
    expect(await (await launch('commons')).store.load()).toEqual(state('commons-new'));
    // A sign-out reaches both of its own copies and nothing else.
    await (await launch('commons')).store.clear();
    expect(await (await launch('commons')).store.load()).toBeNull();
    expect(sessionItemsIn(GROUP.identity)).toEqual([]);
    expect(mockKeychain.get(GROUP.shared, DURABLE)).not.toBeNull();
  });

  it('a split build of Commons or the wallet no longer reads or deletes the shared copy', async () => {
    seed(GROUP.shared, 'mention');
    const commons = await launch('commons', 'split');
    expect(await commons.store.load()).toBeNull();
    await commons.store.clear();
    expect(mockKeychain.get(GROUP.shared, DURABLE)).not.toBeNull();
    expect(await (await launch('wallet', 'split')).store.load()).toBeNull();
  });

  it('a build without either probe makes the calls it always made', async () => {
    const old = await launch('mention', 'preSplit');
    await old.store.save(state('mention'));
    expect(mockKeychain.calls.filter((c) => c.key === DURABLE).map((c) => c.options)).toEqual([
      {},
      {},
    ]);
  });
});

describe('the explicit sign-out marker only withholds', () => {
  it('a shared copy still suppresses automatic sign-in; the app’s own marker is its own', async () => {
    mockKeychain.put(GROUP.shared, MARKER, '1');
    const mention = await launch('mention');
    expect(await mention.store.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
    // The explicit sign-in that releases it releases the shared copy too, as a
    // release always did.
    expect(await mention.store.setAutomaticIdentitySignInSuppressed?.(false)).toBe(true);
    expect(mockKeychain.get(GROUP.shared, MARKER)).toBeNull();

    expect(await (await launch('alia')).store.setAutomaticIdentitySignInSuppressed?.(true)).toBe(
      true,
    );
    expect(mockKeychain.get(APP.alia, MARKER)).toBe('1');
    expect(mockKeychain.get(GROUP.shared, MARKER)).toBeNull();
    expect(await (await launch('mention')).store.isAutomaticIdentitySignInSuppressed?.()).toBe(
      false,
    );
  });

  it('a shared copy that cannot be read counts as suppressed', async () => {
    mockKeychain.failReadGroups.add(GROUP.shared);
    expect(await (await launch('mention')).store.isAutomaticIdentitySignInSuppressed?.()).toBe(
      true,
    );
  });
});

describe('the move never signs anyone out, through a crash or a failure at every step', () => {
  beforeEach(() => {
    // Each injected fault is logged by the store as a failed persist; expected here.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  type Scenario = { app: AppName; earlier: string | null };
  const scenarios: Scenario[] = [
    { app: 'commons', earlier: GROUP.identity },
    { app: 'wallet', earlier: GROUP.wallet },
    { app: 'mention', earlier: null },
  ];

  /** The keychain an upgraded phone has: the app's split-build copy and a foreign shared one. */
  function seedPhone(s: Scenario): PersistedAuthState | null {
    seed(GROUP.shared, 'foreign');
    return s.earlier ? seed(s.earlier, `${s.app}-old`) : null;
  }

  /** Save the new session, then sign out; a thrown step is the crash. */
  async function run(s: Scenario): Promise<{ clearStarted: boolean }> {
    let clearStarted = false;
    try {
      const app = await launch(s.app);
      if (await app.store.save(state(`${s.app}-new`))) {
        clearStarted = true;
        // `clear` swallows a failed delete (non-fatal); the relaunch shows what stayed.
        await app.store.clear();
      }
    } catch {
      // crash
    }
    return { clearStarted };
  }

  for (const s of scenarios) {
    it(`${s.app}: save then sign out`, async () => {
      seedPhone(s);
      mockKeychain.mutations = 0;
      await run(s);
      const total = mockKeychain.mutations;
      expect(await (await launch(s.app)).store.load()).toBeNull();
      expect(total).toBeGreaterThan(0);

      for (let fault = 1; fault <= total; fault += 1) {
        mockKeychain.items.clear();
        const old = seedPhone(s);
        const foreign = mockKeychain.get(GROUP.shared, DURABLE);
        mockKeychain.mutations = 0;
        mockKeychain.failMutationAt = fault;
        const { clearStarted } = await run(s);

        const after = await (await launch(s.app)).store.load();
        // Never another app's session, and the shared copy is untouched.
        expect(after?.sessionId).not.toBe('session-foreign');
        expect(after?.accessToken).not.toBe('token-foreign');
        expect(mockKeychain.get(GROUP.shared, DURABLE)).toBe(foreign);
        if (!clearStarted) {
          // A failed save keeps what the app had: the old session, or the new
          // one when only the best-effort warm token failed.
          expect([old?.sessionId ?? null, `session-${s.app}-new`]).toContain(
            after?.sessionId ?? null,
          );
          if (old && after?.sessionId === old.sessionId) {
            expect(after?.deviceSecret).toBe(old.deviceSecret);
          }
        } else {
          // A failed sign-out never brings back an OLDER session.
          expect(after === null || after.sessionId === `session-${s.app}-new`).toBe(true);
        }
      }
    });
  }

  it('a locked keychain is never remembered as "no application group"', async () => {
    const mention = await launch('mention');
    mockKeychain.locked = true;
    await expect(mention.access()).rejects.toThrow();
    expect(await mention.store.load()).toBeNull();
    mockKeychain.locked = false;
    expect(await mention.access()).toMatchObject({ appGroup: APP.mention });
    await mention.store.save(state('mention'));
    expect(mockKeychain.get(APP.mention, DURABLE)).not.toBeNull();
    expect(mockKeychain.get(GROUP.shared, DURABLE)).toBeNull();
  });

  it('a keychain that refuses the application group keeps the earlier placement', async () => {
    const mention = await launch('mention', 'fixed', true);
    expect(await mention.access()).not.toHaveProperty('appGroup');
    await mention.store.save(state('mention'));
    expect(mockKeychain.get(GROUP.shared, DURABLE)).not.toBeNull();
    const commons = await launch('commons', 'fixed', true);
    await commons.store.save(state('commons'));
    expect(mockKeychain.get(GROUP.identity, DURABLE)).not.toBeNull();
  });
});
