/**
 * Cold boot in IDENTITY mode — the identity vault's boot.
 *
 * Invariants under test:
 *   - a persisted warm token that belongs to ANOTHER account is never planted;
 *     the boot falls through to the PINNED mint instead;
 *   - the mint carries the pinned `accountId`, and the resolved session is the
 *     pinned account even while the device is switched elsewhere;
 *   - `identity-key-signin` (the PRIMARY local key) replaces `shared-key-signin`
 *     (the CROSS-APP shared slot) — and the reverse in account mode;
 *   - with no verified pin the (unpinned) mint lane is skipped entirely rather
 *     than adopting whichever account the device is currently switched to.
 */
import type { DeviceTokenMintResponse } from '@oxy.so/contracts';
import type { OxyServices } from '../../OxyServices';
import type { SessionLoginResponse } from '../../models/session';
import type { AuthChallenge } from '../../crypto/signatureService';
import { runSessionColdBoot } from '../sessionColdBoot';
import type { DeviceSecretMintOutcome } from '../../session/refresh';
import { createMemoryAuthStateStore, type PersistedAuthState } from '../../session/authStateStore';
import { createMemoryIdentityPinStore, type IdentityPin } from '../../session/identityPin';
import type { IdentityBinding } from '../../session/identitySession';

const PUBLIC_KEY = `02${'a'.repeat(64)}`;
const OTHER_PUBLIC_KEY = `03${'b'.repeat(64)}`;
const PIN: IdentityPin = { publicKey: PUBLIC_KEY, accountId: 'vault-user' };

const NATIVE = { isWeb: false, isNative: true };

/** A minimal jwt-decode-able token whose `userId` claim is `accountId`. */
function jwtFor(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ userId: accountId })).toString('base64url');
  return `h.${payload}.s`;
}

/** Comfortably beyond the 60s refresh lead window. */
const farFuture = (): string => new Date(Date.now() + 3_600_000).toISOString();

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

/** The device is switched to `other-user`; the pinned account is still a member. */
const MINT_WHILE_SWITCHED: DeviceTokenMintResponse = {
  accessToken: jwtFor('vault-user'),
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

const IDENTITY_SESSION: SessionLoginResponse = {
  sessionId: 'sess-identity',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-identity',
  deviceSecret: 'ds-identity',
  user: { id: 'vault-user', username: 'vault', name: {} },
};

const SHARED_SESSION: SessionLoginResponse = {
  sessionId: 'sess-shared',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-shared',
  user: { id: 'shared-user', username: 'shared', name: {} },
};

interface OxyOverrides {
  mintFromDeviceSecret?: OxyServices['mintFromDeviceSecret'];
  signInWithSharedIdentity?: OxyServices['signInWithSharedIdentity'];
  requestChallenge?: OxyServices['requestChallenge'];
  verifyChallenge?: OxyServices['verifyChallenge'];
}

function makeOxy(overrides: OxyOverrides = {}): { oxy: OxyServices; setTokens: jest.Mock } {
  const setTokens = jest.fn();
  const oxy = {
    getBaseURL: () => 'https://api.oxy.so',
    setTokens,
    mintFromDeviceSecret:
      overrides.mintFromDeviceSecret
      ?? (async () => {
        throw new Error('mintFromDeviceSecret not stubbed');
      }),
    signInWithSharedIdentity: overrides.signInWithSharedIdentity ?? (async () => null),
    requestChallenge:
      overrides.requestChallenge
      ?? (async () => ({ challenge: 'chal-1', expiresAt: '2030-01-01T00:00:00.000Z' })),
    verifyChallenge: overrides.verifyChallenge ?? (async () => IDENTITY_SESSION),
    httpService: { runSingleFlightDeviceSecretMint: makeMintSingleFlight() },
  } as unknown as OxyServices;
  return { oxy, setTokens };
}

function signWith(publicKey: string): (challenge: string) => Promise<AuthChallenge> {
  return async (challenge) => ({
    challenge: `sig(${challenge})`,
    publicKey,
    timestamp: 1_700_000_000_000,
  });
}

/** An identity binding, optionally pre-seeded with a pin. */
async function makeBinding(options: { pin?: IdentityPin; publicKey?: string } = {}): Promise<IdentityBinding> {
  const publicKey = options.publicKey ?? PUBLIC_KEY;
  const pinStore = createMemoryIdentityPinStore();
  if (options.pin) {
    await pinStore.save(options.pin);
  }
  return { pinStore, readPublicKey: async () => publicKey, signChallenge: signWith(publicKey) };
}

async function seedStore(extra: Partial<PersistedAuthState> = {}) {
  const store = createMemoryAuthStateStore();
  await store.save({
    sessionId: 'sess-vault',
    userId: 'vault-user',
    deviceId: 'dev-1',
    deviceSecret: 'ds-secret-orig',
    ...extra,
  });
  return store;
}

describe('runSessionColdBoot — identity mode: warm-token-plant', () => {
  it('plants a warm token that belongs to the pinned account', async () => {
    const store = await seedStore({ accessToken: jwtFor('vault-user'), expiresAt: farFuture() });
    const { oxy, setTokens } = makeOxy();

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: await makeBinding({ pin: PIN }),
    });

    expect(outcome).toMatchObject({ kind: 'session', via: 'warm-token-plant' });
    expect(setTokens).toHaveBeenCalledWith(jwtFor('vault-user'));
  });

  it('does NOT plant a warm token minted for ANOTHER account — falls through to the pinned mint', async () => {
    // The durable drift: an account-mode re-mint rewrote the persisted session to
    // `other-user` while the device was switched. Identity mode must reject it.
    const store = await seedStore({
      sessionId: 'sess-other',
      userId: 'other-user',
      accessToken: jwtFor('other-user'),
      expiresAt: farFuture(),
    });
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: await makeBinding({ pin: PIN }),
    });

    expect(setTokens).not.toHaveBeenCalledWith(jwtFor('other-user'));
    expect(outcome).toMatchObject({
      kind: 'session',
      via: 'device-secret-mint',
      session: { sessionId: 'sess-vault-new', userId: 'vault-user' },
    });
    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-1', 'ds-secret-orig', {
      accountId: 'vault-user',
    });
  });

  it('does NOT plant a warm token whose persisted identity matches but whose CLAIM does not', async () => {
    // Belt-and-braces: `userId` says the pinned account, the token itself does not.
    const store = await seedStore({ accessToken: jwtFor('other-user'), expiresAt: farFuture() });
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: await makeBinding({ pin: PIN }),
    });

    expect(setTokens).not.toHaveBeenCalledWith(jwtFor('other-user'));
    expect(outcome).toMatchObject({ kind: 'session', via: 'device-secret-mint' });
  });

  it('plants a warm token in ACCOUNT mode regardless of which account it belongs to (unchanged)', async () => {
    const store = await seedStore({
      sessionId: 'sess-other',
      userId: 'other-user',
      accessToken: jwtFor('other-user'),
      expiresAt: farFuture(),
    });
    const { oxy, setTokens } = makeOxy();

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE });

    expect(outcome).toMatchObject({ kind: 'session', via: 'warm-token-plant' });
    expect(setTokens).toHaveBeenCalledWith(jwtFor('other-user'));
  });
});

describe('runSessionColdBoot — identity mode: device-secret-mint', () => {
  it('skips the mint entirely when there is no verified pin', async () => {
    const store = await seedStore();
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: await makeBinding(), // no pin seeded
    });

    // An unpinned mint would have resolved `other-user` — never acceptable here.
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'session',
      via: 'identity-key-signin',
      session: { userId: 'vault-user' },
    });
  });

  it('keeps the device secret and re-establishes when the pinned account left the device', async () => {
    const store = await seedStore();
    const mintFromDeviceSecret = jest.fn(async () => {
      throw Object.assign(new Error('account_not_on_device'), { status: 401 });
    });
    const { oxy } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: await makeBinding({ pin: PIN }),
    });

    expect(outcome).toMatchObject({ kind: 'session', via: 'identity-key-signin' });
    // The healthy credential was never dropped over a stale identity binding
    // (the identity sign-in then overwrote it with the freshly minted one).
    expect(await store.load()).toMatchObject({ deviceSecret: 'ds-identity' });
  });

  it('clears a pin whose key no longer matches, then re-establishes from the current key', async () => {
    const store = await seedStore();
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const pinStore = createMemoryIdentityPinStore();
    await pinStore.save(PIN);

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: {
        pinStore,
        readPublicKey: async () => OTHER_PUBLIC_KEY,
        signChallenge: signWith(OTHER_PUBLIC_KEY),
      },
    });

    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'session', via: 'identity-key-signin' });
    expect(await pinStore.load()).toEqual({ publicKey: OTHER_PUBLIC_KEY, accountId: 'vault-user' });
  });
});

describe('runSessionColdBoot — identity-key-signin vs shared-key-signin', () => {
  it('identity mode runs identity-key-signin and NEVER the shared-keychain lane', async () => {
    const store = createMemoryAuthStateStore(); // no mint credential
    const signInWithSharedIdentity = jest.fn(async () => SHARED_SESSION);
    const requestChallenge = jest.fn(async () => ({
      challenge: 'chal-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    const verifyChallenge = jest.fn(async () => IDENTITY_SESSION);
    const { oxy } = makeOxy({ signInWithSharedIdentity, requestChallenge, verifyChallenge });
    const binding = await makeBinding();
    const onSession = jest.fn();

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: binding,
      onSession,
    });

    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'session', via: 'identity-key-signin' });
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-identity',
        userId: 'vault-user',
        via: 'identity-key-signin',
      }),
    );
    // Boot-path network calls stay single-attempt.
    expect(requestChallenge).toHaveBeenCalledWith(PUBLIC_KEY, { retry: false });
    expect(verifyChallenge).toHaveBeenCalledWith(
      PUBLIC_KEY,
      'chal-1',
      'sig(chal-1)',
      1_700_000_000_000,
      undefined,
      undefined,
      { retry: false },
    );
    // The pin and the fast-lane credential are both written for the next boot.
    expect(await binding.pinStore.load()).toEqual(PIN);
    expect(await store.load()).toMatchObject({ userId: 'vault-user', deviceSecret: 'ds-identity' });
  });

  it('account mode runs shared-key-signin and NEVER the identity lane (unchanged)', async () => {
    const store = createMemoryAuthStateStore();
    const signInWithSharedIdentity = jest.fn(async () => SHARED_SESSION);
    const requestChallenge = jest.fn(async () => ({ challenge: 'c', expiresAt: 'e' }));
    const { oxy } = makeOxy({ signInWithSharedIdentity, requestChallenge });

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE });

    expect(outcome).toMatchObject({ kind: 'session', via: 'shared-key-signin' });
    expect(signInWithSharedIdentity).toHaveBeenCalledWith({ requestOptions: { retry: false } });
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('is offline-gated like every other network step', async () => {
    const store = createMemoryAuthStateStore();
    const requestChallenge = jest.fn(async () => ({ challenge: 'c', expiresAt: 'e' }));
    const { oxy } = makeOxy({ requestChallenge });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      identity: await makeBinding(),
      isOffline: () => true,
      onSignedOut,
    });

    expect(requestChallenge).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
  });

  it('ends signed out (never account-mode) when identity mode is requested without a binding', async () => {
    const store = await seedStore({ accessToken: jwtFor('other-user'), expiresAt: farFuture() });
    const mintFromDeviceSecret = jest.fn(async () => MINT_WHILE_SWITCHED);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sessionMode: 'identity',
      onSignedOut,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('error');
    expect(setTokens).not.toHaveBeenCalled();
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
  });
});
