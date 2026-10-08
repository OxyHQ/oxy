/**
 * `syncIdentityWithServer` never registers a key without a username: the
 * account is created by `POST /auth/register` with the key AND the username in
 * one request, so an unregistered key with no username chosen stops with
 * `UsernameRequiredError` (the caller routes to the username step).
 */

const getPublicKeyMock = jest.fn();
jest.mock('@oxy.so/core/crypto', () => {
  const actual = jest.requireActual('@oxy.so/core/crypto');
  return {
    ...actual,
    KeyManager: { ...actual.KeyManager, getPublicKey: () => getPublicKeyMock() },
    SignatureService: {
      ...actual.SignatureService,
      createRegistrationSignature: jest.fn(async () => ({ signature: 'sig', timestamp: 123 })),
    },
  };
});

// eslint-disable-next-line import/first
import type { OxyServices } from '@oxy.so/core';
// eslint-disable-next-line import/first
import { syncIdentityWithServer } from '@/hooks/identity/syncService';
// eslint-disable-next-line import/first
import { UsernameRequiredError } from '@/hooks/identity/identityErrors';
// eslint-disable-next-line import/first
import { isUsernameRequiredError } from '@/utils/auth/errorUtils';

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function services(auth: { isKeyRegistered: jest.Mock; registerKey?: jest.Mock }) {
  return { auth: { registerKey: jest.fn(async () => ({})), ...auth } } as unknown as OxyServices & {
    auth: { isKeyRegistered: jest.Mock; registerKey: jest.Mock };
  };
}

describe('syncIdentityWithServer', () => {
  const signIn = jest.fn();

  beforeEach(() => {
    getPublicKeyMock.mockReset().mockResolvedValue('pub-1');
    signIn.mockReset().mockResolvedValue({ id: 'u1', username: 'alice' });
  });

  it('an unregistered key with no username is not registered: UsernameRequiredError', async () => {
    const oxy = services({ isKeyRegistered: jest.fn(async () => ({ registered: false })) });

    const sync = syncIdentityWithServer({ oxyServices: oxy, signIn, isAlreadySynced: false });

    await expect(sync).rejects.toBeInstanceOf(UsernameRequiredError);
    await sync.catch((error: unknown) => expect(isUsernameRequiredError(error)).toBe(true));
    expect(oxy.auth.registerKey).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('an unregistered key registers WITH the username, then signs in', async () => {
    const oxy = services({ isKeyRegistered: jest.fn(async () => ({ registered: false })) });

    const result = await syncIdentityWithServer({
      oxyServices: oxy,
      signIn,
      isAlreadySynced: false,
      username: 'alice',
    });

    expect(oxy.auth.registerKey).toHaveBeenCalledWith('pub-1', 'sig', 123, 'alice');
    expect(signIn).toHaveBeenCalledWith('pub-1');
    expect(result).toEqual({ user: { id: 'u1', username: 'alice' }, wasRegistered: true });
  });

  it('a registered key only signs in, whatever username is pending', async () => {
    const oxy = services({ isKeyRegistered: jest.fn(async () => ({ registered: true })) });

    const result = await syncIdentityWithServer({
      oxyServices: oxy,
      signIn,
      isAlreadySynced: false,
      username: 'alice',
    });

    expect(oxy.auth.registerKey).not.toHaveBeenCalled();
    expect(result.wasRegistered).toBe(false);
  });

  it('a taken username is a failure, never read as "already registered"', async () => {
    const oxy = services({
      isKeyRegistered: jest.fn(async () => ({ registered: false })),
      registerKey: jest.fn(async () => {
        throw httpError(409, 'Username already taken');
      }),
    });

    await expect(
      syncIdentityWithServer({ oxyServices: oxy, signIn, isAlreadySynced: false, username: 'alice' }),
    ).rejects.toThrow('Username already taken');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('a key registered meanwhile (409 Identity already registered) signs in', async () => {
    const oxy = services({
      isKeyRegistered: jest.fn(async () => ({ registered: false })),
      registerKey: jest.fn(async () => {
        throw httpError(409, 'Identity already registered');
      }),
    });

    await syncIdentityWithServer({ oxyServices: oxy, signIn, isAlreadySynced: false, username: 'alice' });

    expect(signIn).toHaveBeenCalledWith('pub-1');
  });

  it('a failed registration check with no username surfaces the check error', async () => {
    const oxy = services({
      isKeyRegistered: jest.fn(async () => {
        throw new Error('Network request failed');
      }),
    });

    await expect(
      syncIdentityWithServer({ oxyServices: oxy, signIn, isAlreadySynced: false }),
    ).rejects.toThrow('Network request failed');
    expect(oxy.auth.registerKey).not.toHaveBeenCalled();
  });
});
