/**
 * The re-mint lane under an IDENTITY pin.
 *
 * The durable drift this covers: every background re-mint used to rewrite
 * `PersistedAuthState.userId`/`sessionId` from `state.activeAccountId`, so an
 * account switch made by ANOTHER app on the same device survived a reload
 * through the `warm-token-plant` step. A pinned re-mint must target the pinned
 * account and persist the PINNED account's identity, whatever the device's
 * active account happens to be.
 */
import type { DeviceTokenMintResponse } from '@oxyhq/contracts';
import type { OxyServices } from '../../OxyServices';
import type { SessionLoginResponse } from '../../models/session';
import type { AuthChallenge } from '../../crypto/signatureService';
import {
  refreshDeviceSecretArm,
  refreshPersistedSession,
  type DeviceSecretMintOutcome,
} from '../refresh';
import { createMemoryAuthStateStore, type PersistedAuthState } from '../authStateStore';
import { createMemoryIdentityPinStore, type IdentityPin } from '../identityPin';
import type { IdentityBinding } from '../identitySession';

const PUBLIC_KEY = `02${'a'.repeat(64)}`;
const PIN: IdentityPin = { publicKey: PUBLIC_KEY, accountId: 'vault-user' };

const STORED: PersistedAuthState = {
  sessionId: 'sess-vault',
  userId: 'vault-user',
  deviceId: 'dev-1',
  deviceSecret: 'ds-secret-orig',
};

/**
 * A mint whose device has SWITCHED to another account: `activeAccountId` is
 * `other-user`, while the pinned `vault-user` is still a member. The server
 * minted the token for the pinned account (that is what `accountId` asks for)
 * and reports the device's true active account in `state`.
 */
const MINT_WHILE_SWITCHED: DeviceTokenMintResponse = {
  accessToken: 'access-pinned',
  expiresAt: '2030-01-01T00:00:00.000Z',
  nextDeviceSecret: 'ds-next-secret',
  state: {
    deviceId: 'dev-1',
    accounts: [
      { accountId: 'vault-user', sessionId: 'sess-vault-new', authuser: 0 },
      { accountId: 'other-user', sessionId: 'sess-other', authuser: 1 },
    ],
    activeAccountId: 'other-user',
    revision: 9,
    updatedAt: 1_700_000_000_000,
  },
};

function makeMintSingleFlight(): (mint: () => Promise<DeviceSecretMintOutcome>) => Promise<DeviceSecretMintOutcome> {
  let inFlight: Promise<DeviceSecretMintOutcome> | null = null;
  return (mint) => {
    if (!inFlight) {
      inFlight = mint().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

interface OxyOverrides {
  mintFromDeviceSecret?: OxyServices['mintFromDeviceSecret'];
  signInWithSharedIdentity?: OxyServices['signInWithSharedIdentity'];
  requestChallenge?: OxyServices['requestChallenge'];
  verifyChallenge?: OxyServices['verifyChallenge'];
}

function makeOxy(overrides: OxyOverrides = {}): { oxy: OxyServices; setTokens: jest.Mock } {
  const setTokens = jest.fn();
  const oxy = {
    setTokens,
    mintFromDeviceSecret: overrides.mintFromDeviceSecret ?? (async () => MINT_WHILE_SWITCHED),
    signInWithSharedIdentity: overrides.signInWithSharedIdentity ?? (async () => null),
    requestChallenge:
      overrides.requestChallenge
      ?? (async () => ({ challenge: 'chal-1', expiresAt: '2030-01-01T00:00:00.000Z' })),
    verifyChallenge: overrides.verifyChallenge ?? (async () => IDENTITY_SESSION),
    httpService: { runSingleFlightDeviceSecretMint: makeMintSingleFlight() },
  } as unknown as OxyServices;
  return { oxy, setTokens };
}

const IDENTITY_SESSION: SessionLoginResponse = {
  sessionId: 'sess-reestablished',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-reestablished',
  deviceSecret: 'ds-reestablished',
  user: { id: 'vault-user', username: 'vault', name: {} },
};

const OTHER_PUBLIC_KEY = `03${'b'.repeat(64)}`;

function signWith(publicKey: string): (challenge: string) => Promise<AuthChallenge> {
  return async (challenge) => ({
    challenge: `sig(${challenge})`,
    publicKey,
    timestamp: 1_700_000_000_000,
  });
}

const signChallenge = signWith(PUBLIC_KEY);

/** A binding whose pin store is pre-seeded with {@link PIN}. */
async function makeBinding(): Promise<IdentityBinding> {
  const pinStore = createMemoryIdentityPinStore();
  await pinStore.save(PIN);
  return { pinStore, readPublicKey: async () => PUBLIC_KEY, signChallenge };
}

/** A 401 error shaped like `HttpService`/`handleError` output for the given body. */
function mint401(body: string): Error & { status: number } {
  return Object.assign(new Error(body), { status: 401 });
}

describe('refreshDeviceSecretArm — pinned', () => {
  it('sends the pinned accountId to the mint', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy } = makeOxy({ mintFromDeviceSecret });

    await refreshDeviceSecretArm({ oxy, store, pin: PIN });

    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-1', 'ds-secret-orig', {
      accountId: 'vault-user',
    });
  });

  it('persists the PINNED account identity even though the device is switched elsewhere', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const { oxy, setTokens } = makeOxy();

    const outcome = await refreshDeviceSecretArm({ oxy, store, pin: PIN });

    expect(outcome).toEqual({
      status: 'ok',
      token: 'access-pinned',
      sessionId: 'sess-vault-new',
      userId: 'vault-user',
      state: MINT_WHILE_SWITCHED.state,
    });
    expect(setTokens).toHaveBeenCalledWith('access-pinned');
    expect(await store.load()).toMatchObject({
      // NOT `other-user` / `sess-other`, which is what `activeAccountId` says.
      userId: 'vault-user',
      sessionId: 'sess-vault-new',
      deviceSecret: 'ds-next-secret',
    });
  });

  it('follows activeAccountId when NOT pinned (account mode is unchanged)', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy } = makeOxy({ mintFromDeviceSecret });

    await refreshDeviceSecretArm({ oxy, store });

    // No third argument at all: the account-mode request body is untouched.
    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-1', 'ds-secret-orig');
    expect(await store.load()).toMatchObject({ userId: 'other-user', sessionId: 'sess-other' });
  });

  it('classifies a 401 account_not_on_device as its own outcome (never a bad secret)', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const { oxy } = makeOxy({
      mintFromDeviceSecret: async () => {
        throw mint401('account_not_on_device: vault-user is not a live account of this device session');
      },
    });

    expect(await refreshDeviceSecretArm({ oxy, store, pin: PIN })).toEqual({
      status: 'account-not-on-device',
    });
    // The healthy device credential is untouched.
    expect(await store.load()).toMatchObject({ deviceSecret: 'ds-secret-orig' });
  });
});

describe('refreshPersistedSession — pinned', () => {
  it('never runs the shared-keychain arm; re-establishes from the primary key instead', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy } = makeOxy({
      signInWithSharedIdentity,
      mintFromDeviceSecret: async () => {
        throw mint401('invalid_device_secret');
      },
    });

    const token = await refreshPersistedSession({
      oxy,
      store,
      allowSharedKeyFallback: true, // explicitly requested — and explicitly ignored when pinned
      identity: await makeBinding(),
    });

    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
    expect(token).toBe('access-reestablished');
    // The identity sign-in repopulated the fast lane for the pinned account.
    expect(await store.load()).toMatchObject({
      userId: 'vault-user',
      sessionId: 'sess-reestablished',
      deviceSecret: 'ds-reestablished',
    });
  });

  it('re-establishes from the primary key when the pinned account left the device', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const mintFromDeviceSecret = jest.fn(async () => {
      throw mint401('account_not_on_device');
    });
    const { oxy } = makeOxy({ mintFromDeviceSecret });

    const token = await refreshPersistedSession({ oxy, store, identity: await makeBinding() });

    expect(mintFromDeviceSecret).toHaveBeenCalled();
    expect(token).toBe('access-reestablished');
  });

  it('skips the mint entirely and re-establishes when the local key no longer matches the pin', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const pinStore = createMemoryIdentityPinStore();
    await pinStore.save(PIN);

    const token = await refreshPersistedSession({
      oxy,
      store,
      // The device's identity was replaced — the stale pin must not survive it.
      identity: {
        pinStore,
        readPublicKey: async () => OTHER_PUBLIC_KEY,
        signChallenge: signWith(OTHER_PUBLIC_KEY),
      },
    });

    // An UNPINNED mint here would have adopted `other-user` — the drift the pin exists to stop.
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(token).toBe('access-reestablished');
    // The pin now binds the CURRENT key to the account the server resolved for it.
    expect(await pinStore.load()).toEqual({
      publicKey: OTHER_PUBLIC_KEY,
      accountId: 'vault-user',
    });
  });

  it('returns null (signed out) when the identity cannot be read — never falls back to the active account', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const pinStore = createMemoryIdentityPinStore();
    await pinStore.save(PIN);

    const token = await refreshPersistedSession({
      oxy,
      store,
      identity: {
        pinStore,
        readPublicKey: async () => {
          throw new Error('keychain locked');
        },
        signChallenge,
      },
    });

    expect(token).toBeNull();
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    // A locked keychain is not evidence of an identity change — the pin survives.
    expect(await pinStore.load()).toEqual(PIN);
  });

  it('keeps the deviceId (drops only the secret) on a 401 so the identity arm can recover', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const { oxy } = makeOxy({
      mintFromDeviceSecret: async () => {
        throw mint401('invalid_device_secret');
      },
      // The identity arm yields nothing this time (e.g. offline), so the store
      // state after the 401 is observable.
      verifyChallenge: async () => ({ ...IDENTITY_SESSION, accessToken: undefined }),
    });

    const token = await refreshPersistedSession({ oxy, store, identity: await makeBinding() });

    expect(token).toBeNull();
    const persisted = await store.load();
    expect(persisted?.deviceId).toBe('dev-1');
    expect(persisted?.deviceSecret).toBeUndefined();
  });
});
