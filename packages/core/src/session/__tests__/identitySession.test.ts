/**
 * Identity-bound session helpers.
 *
 * `resolveIdentityPin` is the trust gate: a pin is only honoured while the
 * device still holds the key that produced it. `establishIdentitySession` is the
 * primary-key sign-in the identity vault used to run in app code, now owned by
 * the SDK.
 */
import type { OxyServices } from '../../OxyServices';
import type { SessionLoginResponse } from '../../models/session';
import type { AuthChallenge } from '../../crypto/signatureService';
import { createMemoryAuthStateStore } from '../authStateStore';
import { createMemoryIdentityPinStore, type IdentityPin } from '../identityPin';
import {
  establishIdentitySession,
  resolveIdentityPin,
  type IdentityBinding,
} from '../identitySession';

const PUBLIC_KEY = `02${'a'.repeat(64)}`;
const OTHER_PUBLIC_KEY = `03${'b'.repeat(64)}`;
const PIN: IdentityPin = { publicKey: PUBLIC_KEY, accountId: 'acct-1' };

const SESSION: SessionLoginResponse = {
  sessionId: 'sess-identity',
  deviceId: 'dev-identity',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-identity',
  deviceSecret: 'ds-identity',
  user: { id: 'acct-1', username: 'vault', name: {} },
};

interface OxyOverrides {
  requestChallenge?: OxyServices['auth']['requestChallenge'];
  verifyChallenge?: OxyServices['auth']['verifyChallenge'];
}

function makeOxy(overrides: OxyOverrides = {}): OxyServices {
  return {
    auth: {
      requestChallenge: overrides.requestChallenge
      ?? (async () => ({ challenge: 'chal-1', expiresAt: '2030-01-01T00:00:00.000Z' })),
      verifyChallenge: overrides.verifyChallenge ?? (async () => SESSION),
    },
  } as unknown as OxyServices;
}

function signWith(publicKey: string): (challenge: string) => Promise<AuthChallenge> {
  return async (challenge) => ({ challenge: `sig(${challenge})`, publicKey, timestamp: 1_700_000_000_000 });
}

describe('resolveIdentityPin', () => {
  it('returns null when nothing is pinned', async () => {
    const binding: IdentityBinding = {
      pinStore: createMemoryIdentityPinStore(),
      readPublicKey: async () => PUBLIC_KEY,
    };
    expect(await resolveIdentityPin(binding)).toBeNull();
  });

  it('returns the pin when the local key still matches', async () => {
    const pinStore = createMemoryIdentityPinStore();
    await pinStore.save(PIN);
    expect(await resolveIdentityPin({ pinStore, readPublicKey: async () => PUBLIC_KEY })).toEqual(PIN);
  });

  it('CLEARS the pin when the local key was replaced', async () => {
    const pinStore = createMemoryIdentityPinStore();
    await pinStore.save(PIN);

    expect(await resolveIdentityPin({ pinStore, readPublicKey: async () => OTHER_PUBLIC_KEY })).toBeNull();
    expect(await pinStore.load()).toBeNull();
  });

  it('CLEARS the pin when the identity is gone (definitive empty read)', async () => {
    const pinStore = createMemoryIdentityPinStore();
    await pinStore.save(PIN);

    expect(await resolveIdentityPin({ pinStore, readPublicKey: async () => null })).toBeNull();
    expect(await pinStore.load()).toBeNull();
  });

  it('KEEPS the pin when the key read threw (locked keychain is not an identity change)', async () => {
    const pinStore = createMemoryIdentityPinStore();
    await pinStore.save(PIN);

    const resolved = await resolveIdentityPin({
      pinStore,
      readPublicKey: async () => {
        throw new Error('IdentityUnavailable');
      },
    });

    // Unresolved for this boot...
    expect(resolved).toBeNull();
    // ...but the binding survives for the next attempt.
    expect(await pinStore.load()).toEqual(PIN);
  });
});

describe('establishIdentitySession', () => {
  it('signs with the PRIMARY key, persists the device credential, and writes the pin', async () => {
    const store = createMemoryAuthStateStore();
    const pinStore = createMemoryIdentityPinStore();
    const requestChallenge = jest.fn(async () => ({
      challenge: 'chal-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    const verifyChallenge = jest.fn(async () => SESSION);
    const oxy = makeOxy({ requestChallenge, verifyChallenge });

    const established = await establishIdentitySession({
      oxy,
      store,
      binding: {
        pinStore,
        readPublicKey: async () => PUBLIC_KEY,
        signChallenge: signWith(PUBLIC_KEY),
        deviceName: 'Vault',
      },
      requestOptions: { retry: false },
    });

    expect(requestChallenge).toHaveBeenCalledWith(PUBLIC_KEY, { retry: false });
    expect(verifyChallenge).toHaveBeenCalledWith(
      PUBLIC_KEY,
      'chal-1',
      'sig(chal-1)',
      1_700_000_000_000,
      'Vault',
      undefined,
      { retry: false },
    );
    expect(established?.pin).toEqual(PIN);
    expect(await pinStore.load()).toEqual(PIN);
    expect(await store.load()).toMatchObject({
      sessionId: 'sess-identity',
      userId: 'acct-1',
      deviceId: 'dev-identity',
      deviceSecret: 'ds-identity',
      accessToken: 'access-identity',
    });
  });

  it('returns null (never throws) when the device holds no identity — the web case', async () => {
    const pinStore = createMemoryIdentityPinStore();
    const requestChallenge = jest.fn(async () => ({ challenge: 'c', expiresAt: 'e' }));

    const established = await establishIdentitySession({
      oxy: makeOxy({ requestChallenge }),
      store: createMemoryAuthStateStore(),
      binding: { pinStore, readPublicKey: async () => null },
    });

    expect(established).toBeNull();
    expect(requestChallenge).not.toHaveBeenCalled();
    expect(await pinStore.load()).toBeNull();
  });

  it('refuses to verify when the signer disagrees with the device identity key', async () => {
    const pinStore = createMemoryIdentityPinStore();
    const verifyChallenge = jest.fn(async () => SESSION);

    await expect(
      establishIdentitySession({
        oxy: makeOxy({ verifyChallenge }),
        store: createMemoryAuthStateStore(),
        binding: {
          pinStore,
          readPublicKey: async () => PUBLIC_KEY,
          signChallenge: signWith(OTHER_PUBLIC_KEY),
        },
      }),
    ).rejects.toThrow(/signing key does not match/);

    expect(verifyChallenge).not.toHaveBeenCalled();
    expect(await pinStore.load()).toBeNull();
  });

  it('keeps the established session when the pin write fails (re-established next boot)', async () => {
    const pinStore = {
      load: async () => null,
      save: async () => false,
      clear: async () => undefined,
    };

    const established = await establishIdentitySession({
      oxy: makeOxy(),
      store: createMemoryAuthStateStore(),
      binding: { pinStore, readPublicKey: async () => PUBLIC_KEY, signChallenge: signWith(PUBLIC_KEY) },
    });

    expect(established?.session.accessToken).toBe('access-identity');
  });
});
