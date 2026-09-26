/**
 * Signing in without a passkey on OxyServices: each method hits its endpoint
 * bearer-less with the right body, attaches THIS client's device proof unless
 * told otherwise, plants the access token of a session and never of a
 * second-factor step, and validates every answer against the contracts.
 */
import type { LoginResult } from '@oxy.so/contracts';
import { OxyServices, SecondFactorRequiredError } from '../../OxyServices';

const SESSION: LoginResult = {
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-1',
  deviceSecret: 'ds-1',
  user: { id: 'user-1', username: 'u' },
};
const TOKEN = 'A'.repeat(43);
const CHALLENGE = { secondFactorRequired: true as const, challengeId: 'C'.repeat(43), expiresAt: 1_900_000_000_000 };
const DEVICE = { deviceId: 'browser-device', deviceSecret: 'browser-secret' };
const PRE_SESSION = { cache: false, skipAuth: true };

let oxy: OxyServices;
let makeRequest: jest.SpyInstance;
let setTokens: jest.SpyInstance;

beforeEach(() => {
  oxy = new OxyServices({ baseURL: 'http://test.invalid' });
  makeRequest = jest.spyOn(oxy, 'makeRequest');
  setTokens = jest.spyOn(oxy, 'setTokens');
  oxy.setDeviceCredentialProvider(() => DEVICE);
});
afterEach(() => jest.restoreAllMocks());

describe('email sign-in', () => {
  it('starts with the identifier and this browser device', async () => {
    makeRequest.mockResolvedValueOnce({ requestId: 'r1', requestSecret: TOKEN, expiresAt: 1_900_000_000_000 });
    const started = await oxy.startEmailSignIn('ada');
    expect(started.requestSecret).toBe(TOKEN);
    expect(makeRequest).toHaveBeenCalledWith('POST', '/auth/signin/email/start', { identifier: 'ada', device: DEVICE }, PRE_SESSION);
  });

  it('confirms the code into a session and plants its token', async () => {
    makeRequest.mockResolvedValueOnce(SESSION);
    const result = await oxy.confirmEmailSignIn({ requestId: 'r1', requestSecret: TOKEN, code: '123456' });
    expect(result).toEqual(SESSION);
    expect(setTokens).toHaveBeenCalledWith('access-1');
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/signin/email/confirm',
      { requestId: 'r1', requestSecret: TOKEN, code: '123456', device: DEVICE },
      PRE_SESSION,
    );
  });

  it('returns the second-factor step without planting anything', async () => {
    makeRequest.mockResolvedValueOnce(CHALLENGE);
    const result = await oxy.confirmEmailSignIn({ requestId: 'r1', requestSecret: TOKEN, code: '123456', device: null });
    expect(result).toEqual(CHALLENGE);
    expect(setTokens).not.toHaveBeenCalled();
    expect(makeRequest.mock.calls[0][2]).not.toHaveProperty('device');
  });

  it('collects: pending until the link is opened, then the session', async () => {
    makeRequest.mockResolvedValueOnce({ status: 'pending', expiresAt: 1_900_000_000_000 });
    expect(await oxy.collectEmailSignIn({ requestId: 'r1', requestSecret: TOKEN })).toEqual({ status: 'pending', expiresAt: 1_900_000_000_000 });
    makeRequest.mockResolvedValueOnce(SESSION);
    expect(await oxy.collectEmailSignIn({ requestId: 'r1', requestSecret: TOKEN })).toEqual(SESSION);
    expect(makeRequest).toHaveBeenLastCalledWith(
      'POST',
      '/auth/signin/email/collect',
      { requestId: 'r1', requestSecret: TOKEN, device: DEVICE },
      PRE_SESSION,
    );
  });

  it("approves a link with this browser's device, and refuses without one", async () => {
    makeRequest.mockResolvedValueOnce({ approved: true });
    expect(await oxy.approveEmailSignInLink(TOKEN)).toEqual({ approved: true });
    expect(makeRequest).toHaveBeenCalledWith('POST', '/auth/signin/email/link', { token: TOKEN, device: DEVICE }, PRE_SESSION);

    oxy.setDeviceCredentialProvider(null);
    await expect(oxy.approveEmailSignInLink(TOKEN)).rejects.toThrow();
  });

  it('refuses an answer that is neither', async () => {
    makeRequest.mockResolvedValueOnce({ unexpected: true });
    await expect(oxy.confirmEmailSignIn({ requestId: 'r1', requestSecret: TOKEN, code: '123456' })).rejects.toThrow();
  });
});

describe('password, second factor and sign-up', () => {
  it('signs in with a password', async () => {
    makeRequest.mockResolvedValueOnce(SESSION);
    await oxy.signInWithPassword({ identifier: 'ada', password: 'secret password', deviceName: 'Laptop' });
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/signin/password',
      { identifier: 'ada', password: 'secret password', deviceName: 'Laptop', device: DEVICE },
      PRE_SESSION,
    );
    expect(setTokens).toHaveBeenCalledWith('access-1');
  });

  it('completes the second factor with the same device', async () => {
    makeRequest.mockResolvedValueOnce(SESSION);
    await oxy.completeSecondFactor({ challengeId: CHALLENGE.challengeId, code: '123456' });
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/signin/second-factor',
      { challengeId: CHALLENGE.challengeId, code: '123456', device: DEVICE },
      PRE_SESSION,
    );
  });

  it('never accepts a second-factor step as the answer to the second factor', async () => {
    makeRequest.mockResolvedValueOnce(CHALLENGE);
    await expect(oxy.completeSecondFactor({ challengeId: CHALLENGE.challengeId, code: '123456' })).rejects.toThrow();
  });

  it('signs up with the confirmed email', async () => {
    makeRequest.mockResolvedValueOnce(SESSION);
    await oxy.signUp({ username: 'ada', email: 'ada@example.com', emailTicket: TOKEN });
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/signup',
      { username: 'ada', email: 'ada@example.com', emailTicket: TOKEN, device: DEVICE },
      PRE_SESSION,
    );
  });
});

describe('the signed-in account', () => {
  const reauth = { emailCode: { verificationId: 'v1', code: '123456' } };

  it('reads its sign-in methods and asks for a confirmation code with the bearer', async () => {
    makeRequest.mockResolvedValueOnce({ hasEmail: true, hasPassword: false, totpEnabled: false, backupCodesRemaining: 0 });
    await oxy.getSignInMethods();
    expect(makeRequest).toHaveBeenCalledWith('GET', '/users/me/sign-in-methods', undefined, { cache: false });
    makeRequest.mockResolvedValueOnce({ verificationId: 'v1', expiresAt: 1_900_000_000_000 });
    await oxy.requestReauthEmailCode('delete_account');
    expect(makeRequest).toHaveBeenLastCalledWith('POST', '/users/me/reauth/email', { action: 'delete_account' }, { cache: false });
  });

  it('sets a password with its proof', async () => {
    makeRequest.mockResolvedValueOnce({ success: true });
    await oxy.setPassword({ newPassword: 'a new password', reauth, revokeOtherSessions: true });
    expect(makeRequest).toHaveBeenCalledWith(
      'PUT',
      '/users/me/password',
      { newPassword: 'a new password', reauth, revokeOtherSessions: true },
      { cache: false },
    );
  });

  it('enrols, confirms, regenerates and disables the authenticator', async () => {
    makeRequest.mockResolvedValueOnce({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Oxy:ada?secret=JBSWY3DPEHPK3PXP' });
    expect((await oxy.enrollTotp()).secret).toBe('JBSWY3DPEHPK3PXP');
    const codes = Array.from({ length: 10 }, (_, index) => `abcd${index % 8 + 2}-efghj`);
    makeRequest.mockResolvedValueOnce({ backupCodes: codes });
    expect(await oxy.confirmTotp('123456', reauth)).toEqual(codes);
    expect(makeRequest).toHaveBeenLastCalledWith('POST', '/users/me/totp/confirm', { code: '123456', reauth }, { cache: false });
    makeRequest.mockResolvedValueOnce({ backupCodes: codes });
    await oxy.regenerateTotpBackupCodes(reauth);
    makeRequest.mockResolvedValueOnce({ success: true });
    await oxy.disableTotp(reauth);
    expect(makeRequest).toHaveBeenLastCalledWith('POST', '/users/me/totp/disable', { reauth }, { cache: false });
  });

  it('deletes the account and completes a Commons link with an email code', async () => {
    makeRequest.mockResolvedValueOnce({ message: 'ok' });
    await oxy.deleteAccountWithEmailCode('ada', reauth);
    expect(makeRequest).toHaveBeenCalledWith('DELETE', '/users/me', { confirmText: 'ada', reauth }, { cache: false });
    makeRequest.mockResolvedValueOnce({ success: true });
    await oxy.completeIdentityLinkWithEmailCode('ab'.repeat(16), reauth);
    expect(makeRequest).toHaveBeenLastCalledWith('POST', `/identity/link/${'ab'.repeat(16)}/complete`, { reauth }, { cache: false });
  });
});

describe('passkey sign-in with an authenticator on the account', () => {
  it('throws SecondFactorRequiredError carrying the challenge, and plants nothing', async () => {
    makeRequest.mockResolvedValueOnce(CHALLENGE);
    const error = await oxy.webauthnLoginVerify({ id: 'cred' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecondFactorRequiredError);
    expect(error).toMatchObject({ challengeId: CHALLENGE.challengeId, code: 'SECOND_FACTOR_REQUIRED' });
    makeRequest.mockResolvedValueOnce(CHALLENGE);
    await expect(oxy.webauthnRegisterVerify({ id: 'cred' }, { recoveryTicket: TOKEN })).rejects.toBeInstanceOf(SecondFactorRequiredError);
    expect(setTokens).not.toHaveBeenCalled();
  });
});
