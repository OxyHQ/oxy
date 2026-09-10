/**
 * `passkeyFlow` — the pure, deps-injected passkey (WebAuthn) orchestration that
 * backs `useOxy().signInWithPasskey` / `registerWithPasskey` / `addPasskey`.
 *
 * These tests assert the fixed `options → ceremony → verify → commit` ordering,
 * the exact `commitSession` input projected from a session-arm login result, the
 * `isSupported()` gate, and the branch discipline (sign-in/register commit a
 * session; add links WITHOUT committing and fires `onLinked`) — the same
 * deps-injection style `commitSessionFlow.test.ts` uses.
 */

import type { LoginSessionResult } from '@oxy.so/contracts';
import {
  runPasskeyLogin,
  runPasskeyRegister,
  runPasskeyAdd,
  PASSKEY_UNSUPPORTED_MESSAGE,
  type RunPasskeyLoginDeps,
  type RunPasskeyRegisterDeps,
  type RunPasskeyAddDeps,
  type PasskeyRegisterVerifyResult,
} from '../passkeyFlow';
import type { CommitInput } from '../oxyContextTypes';

const SESSION_USER_ID = 'user_pk_1';

/** A full session arm of the login contract (mirrors `webauthn*Verify`'s signup/login output). */
const sessionResult: LoginSessionResult = {
  sessionId: 'sess_pk',
  deviceId: 'dev_pk',
  accessToken: 'pk.access.token',
  deviceSecret: 'pk.device.secret',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  user: { id: SESSION_USER_ID, username: 'pkuser' },
};

/** The `commitSession` input the flow projects from `sessionResult`. */
const expectedCommitInput: CommitInput = {
  sessionId: 'sess_pk',
  accessToken: 'pk.access.token',
  deviceSecret: 'pk.device.secret',
  deviceId: 'dev_pk',
  expiresAt: sessionResult.expiresAt,
  userId: SESSION_USER_ID,
  user: { id: SESSION_USER_ID, username: 'pkuser' },
};

const linkResult: PasskeyRegisterVerifyResult = { success: true, message: 'Passkey added' };

describe('runPasskeyLogin', () => {
  const buildDeps = (
    order: string[],
    overrides: Partial<RunPasskeyLoginDeps> = {},
  ): RunPasskeyLoginDeps => ({
    isSupported: jest.fn(() => true),
    getLoginOptions: jest.fn(async () => {
      order.push('getLoginOptions');
      return { challenge: 'login-opts' };
    }),
    runCeremony: jest.fn(async (options) => {
      order.push('runCeremony');
      expect(options).toEqual({ challenge: 'login-opts' });
      return { id: 'assertion' };
    }),
    loginVerify: jest.fn(async () => {
      order.push('loginVerify');
      return sessionResult;
    }),
    commit: jest.fn(async () => {
      order.push('commit');
    }),
    deviceId: 'persisted-dev',
    deviceName: 'My Laptop',
    deviceFingerprint: 'fp-123',
    ...overrides,
  });

  it('drives options → ceremony → verify → commit and threads the device envelope', async () => {
    const order: string[] = [];
    const deps = buildDeps(order);

    await runPasskeyLogin(deps);

    expect(order).toEqual(['getLoginOptions', 'runCeremony', 'loginVerify', 'commit']);
    // The assertion response is forwarded to verify with the device envelope.
    expect(deps.loginVerify).toHaveBeenCalledWith(
      { id: 'assertion' },
      { deviceName: 'My Laptop', deviceFingerprint: 'fp-123', deviceId: 'persisted-dev' },
    );
    // The session arm is projected onto the exact commitSession input.
    expect(deps.commit).toHaveBeenCalledWith(expectedCommitInput);
  });

  it('forwards the username to getLoginOptions for the username-first (hardware-key) path', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, { username: 'alice' });

    await runPasskeyLogin(deps);

    // The username scopes login options to that user's passkeys — the path a
    // non-discoverable U2F/security key needs.
    expect(deps.getLoginOptions).toHaveBeenCalledWith('alice');
  });

  it('passes undefined to getLoginOptions for the usernameless (discoverable) path', async () => {
    const order: string[] = [];
    const deps = buildDeps(order);

    await runPasskeyLogin(deps);

    // No username → discoverable-credential ceremony (server returns an empty allow-list).
    expect(deps.getLoginOptions).toHaveBeenCalledWith(undefined);
  });

  it('throws and touches nothing when passkeys are unsupported', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, { isSupported: jest.fn(() => false) });

    await expect(runPasskeyLogin(deps)).rejects.toThrow(PASSKEY_UNSUPPORTED_MESSAGE);
    expect(deps.getLoginOptions).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });
});

describe('runPasskeyRegister', () => {
  const buildDeps = (
    order: string[],
    overrides: Partial<RunPasskeyRegisterDeps> = {},
  ): RunPasskeyRegisterDeps => ({
    isSupported: jest.fn(() => true),
    getRegisterOptions: jest.fn(async (username) => {
      order.push('getRegisterOptions');
      expect(username).toBe('newuser');
      return { challenge: 'reg-opts' };
    }),
    runCeremony: jest.fn(async () => {
      order.push('runCeremony');
      return { id: 'attestation' };
    }),
    registerVerify: jest.fn(async () => {
      order.push('registerVerify');
      return sessionResult;
    }),
    commit: jest.fn(async () => {
      order.push('commit');
    }),
    username: 'newuser',
    deviceName: 'My Laptop',
    ...overrides,
  });

  it('creates the account (signup branch) and commits the minted session', async () => {
    const order: string[] = [];
    const deps = buildDeps(order);

    await runPasskeyRegister(deps);

    expect(order).toEqual(['getRegisterOptions', 'runCeremony', 'registerVerify', 'commit']);
    expect(deps.registerVerify).toHaveBeenCalledWith(
      { id: 'attestation' },
      { username: 'newuser', deviceName: 'My Laptop' },
    );
    expect(deps.commit).toHaveBeenCalledWith(expectedCommitInput);
  });

  it('throws (no commit) when verify returns a link branch instead of a session', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, {
      registerVerify: jest.fn(async () => linkResult),
    });

    await expect(runPasskeyRegister(deps)).rejects.toThrow(/did not establish a session/i);
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('throws and touches nothing when passkeys are unsupported', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, { isSupported: jest.fn(() => false) });

    await expect(runPasskeyRegister(deps)).rejects.toThrow(PASSKEY_UNSUPPORTED_MESSAGE);
    expect(deps.getRegisterOptions).not.toHaveBeenCalled();
    expect(deps.commit).not.toHaveBeenCalled();
  });
});

describe('runPasskeyAdd', () => {
  const buildDeps = (
    order: string[],
    overrides: Partial<RunPasskeyAddDeps> = {},
  ): RunPasskeyAddDeps => ({
    isSupported: jest.fn(() => true),
    getRegisterOptions: jest.fn(async () => {
      order.push('getRegisterOptions');
      return { challenge: 'add-opts' };
    }),
    runCeremony: jest.fn(async () => {
      order.push('runCeremony');
      return { id: 'attestation' };
    }),
    registerVerify: jest.fn(async () => {
      order.push('registerVerify');
      return linkResult;
    }),
    onLinked: jest.fn(() => {
      order.push('onLinked');
    }),
    deviceName: 'My Laptop',
    ...overrides,
  });

  it('links the passkey WITHOUT committing a session and fires onLinked', async () => {
    const order: string[] = [];
    const deps = buildDeps(order);

    await runPasskeyAdd(deps);

    expect(order).toEqual(['getRegisterOptions', 'runCeremony', 'registerVerify', 'onLinked']);
    // Add requests options with NO username (bearer scopes it to the signed-in user).
    expect(deps.getRegisterOptions).toHaveBeenCalledWith();
    expect(deps.registerVerify).toHaveBeenCalledWith({ id: 'attestation' }, { deviceName: 'My Laptop' });
    expect(deps.onLinked).toHaveBeenCalledTimes(1);
    // There is no `commit` dependency at all — structurally cannot commit a session.
    expect('commit' in deps).toBe(false);
  });

  it('throws (no onLinked) if verify unexpectedly mints a session', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, {
      registerVerify: jest.fn(async () => sessionResult),
    });

    await expect(runPasskeyAdd(deps)).rejects.toThrow(/instead of linking/i);
    expect(deps.onLinked).not.toHaveBeenCalled();
  });

  it('throws and touches nothing when passkeys are unsupported', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, { isSupported: jest.fn(() => false) });

    await expect(runPasskeyAdd(deps)).rejects.toThrow(PASSKEY_UNSUPPORTED_MESSAGE);
    expect(deps.getRegisterOptions).not.toHaveBeenCalled();
    expect(deps.onLinked).not.toHaveBeenCalled();
  });
});
