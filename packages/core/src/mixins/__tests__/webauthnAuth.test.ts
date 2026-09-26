/**
 * WebAuthn / passkey auth methods on OxyServices
 * (`webauthnRegisterOptions` / `webauthnRegisterVerify` /
 * `webauthnLoginOptions` / `webauthnLoginVerify`).
 *
 * Stubs `makeRequest` (HTTP-mock style) and
 * asserts: each method hits the right endpoint with the right body; the opaque
 * ceremony `response` is forwarded verbatim; the login/verify + register/verify
 * (signup) paths parse the login contract and plant the access token on the
 * session arm; register/verify (link) returns `{ success, message }` WITHOUT
 * planting a token.
 */
import type { LoginResult } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';

const SESSION_ARM: LoginResult = {
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  accessToken: 'access-1',
  deviceSecret: 'ds-secret-1',
  user: { id: 'user-1', username: 'u' },
};

const LINK_RESULT = { success: true as const, message: 'Passkey registered successfully' };

// Opaque browser ceremony payloads — Oxy never inspects these, so shape is
// irrelevant beyond "forwarded verbatim under `response`".
const CREATE_RESPONSE = { id: 'cred-abc', rawId: 'cred-abc', response: { attestationObject: 'ao' }, type: 'public-key' };
const GET_RESPONSE = { id: 'cred-abc', rawId: 'cred-abc', response: { signature: 'sig' }, type: 'public-key' };

describe('webauthnRegisterOptions', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
  });
  afterEach(() => jest.restoreAllMocks());

  it('POSTs to /auth/webauthn/register/options with the username', async () => {
    const options = { challenge: 'c', rp: { id: 'oxy.so' } };
    makeRequest.mockResolvedValueOnce(options);
    const result = await oxy.webauthnRegisterOptions({ username: 'alice' });
    expect(result).toBe(options);
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/register/options',
      { username: 'alice' },
      { cache: false, skipAuth: true },
    );
  });

  it('sends a recovery ticket signed out', async () => {
    makeRequest.mockResolvedValueOnce({ challenge: 'c' });
    await oxy.webauthnRegisterOptions({ recoveryTicket: 't'.repeat(43) });
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/register/options',
      { recoveryTicket: 't'.repeat(43) },
      { cache: false, skipAuth: true },
    );
  });

  it('omits username from the body when not provided (link flow)', async () => {
    makeRequest.mockResolvedValueOnce({ challenge: 'c' });
    await oxy.webauthnRegisterOptions();
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/register/options',
      {},
      { cache: false },
    );
  });
});

describe('email verification', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
  });
  afterEach(() => jest.restoreAllMocks());

  it('starts a verification signed out and parses its id', async () => {
    makeRequest.mockResolvedValueOnce({ verificationId: 'v-1', expiresAt: 1_900_000_000_000 });
    await expect(oxy.startEmailVerification({ purpose: 'signup', email: 'ada@example.com' })).resolves.toEqual({
      verificationId: 'v-1',
      expiresAt: 1_900_000_000_000,
    });
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/email/verify/start',
      { purpose: 'signup', email: 'ada@example.com' },
      { cache: false, skipAuth: true },
    );
  });

  it('confirms a code into a ticket', async () => {
    const confirmed = { ticket: 'T'.repeat(43), expiresAt: 1_900_000_000_000, username: 'ada' };
    makeRequest.mockResolvedValueOnce(confirmed);
    await expect(oxy.confirmEmailVerification('v-1', '123456')).resolves.toEqual(confirmed);
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/email/verify/confirm',
      { verificationId: 'v-1', code: '123456' },
      { cache: false, skipAuth: true },
    );
  });

  it('refuses a malformed answer rather than handing on a ticket it cannot read', async () => {
    makeRequest.mockResolvedValueOnce({ ticket: 'short', expiresAt: 1 });
    await expect(oxy.confirmEmailVerification('v-1', '123456')).rejects.toThrow();
  });
});

describe('webauthnLoginOptions', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
  });
  afterEach(() => jest.restoreAllMocks());

  it('POSTs to /auth/webauthn/login/options with the username (username-first)', async () => {
    const options = { challenge: 'c', allowCredentials: [{ id: 'cred-abc' }] };
    makeRequest.mockResolvedValueOnce(options);
    const result = await oxy.webauthnLoginOptions('alice');
    expect(result).toBe(options);
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/login/options',
      { username: 'alice' },
      { cache: false, skipAuth: true },
    );
  });

  it('omits username for the usernameless / discoverable flow', async () => {
    makeRequest.mockResolvedValueOnce({ challenge: 'c', allowCredentials: [] });
    await oxy.webauthnLoginOptions();
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/login/options',
      {},
      { cache: false, skipAuth: true },
    );
  });
});

describe('webauthnRegisterVerify', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;
  let setTokens: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
    setTokens = jest.spyOn(oxy, 'setTokens').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('signup branch: parses LoginSessionResult, plants the token, threads the envelope', async () => {
    makeRequest.mockResolvedValueOnce(SESSION_ARM);
    const result = await oxy.webauthnRegisterVerify(CREATE_RESPONSE, {
      username: 'alice',
      deviceName: 'Phone',
      deviceFingerprint: 'fp-1',
    });
    expect(result).toEqual(SESSION_ARM);
    expect('twoFactorRequired' in result).toBe(false);
    if (!('twoFactorRequired' in result) && 'sessionId' in result) {
      expect(result.deviceId).toBe('dev-1');
      expect(result.deviceSecret).toBe('ds-secret-1');
    }
    expect(setTokens).toHaveBeenCalledWith('access-1');
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/register/verify',
      { response: CREATE_RESPONSE, username: 'alice', deviceName: 'Phone', deviceFingerprint: 'fp-1' },
      { cache: false, skipAuth: true },
    );
  });

  it('link branch: returns { success, message } WITHOUT planting a token', async () => {
    makeRequest.mockResolvedValueOnce(LINK_RESULT);
    const result = await oxy.webauthnRegisterVerify(CREATE_RESPONSE, { deviceName: 'Laptop' });
    expect(result).toEqual(LINK_RESULT);
    expect(setTokens).not.toHaveBeenCalled();
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/register/verify',
      { response: CREATE_RESPONSE, deviceName: 'Laptop' },
      { cache: false },
    );
  });

  it('throws on an unexpected response shape', async () => {
    makeRequest.mockResolvedValueOnce({ nope: true });
    await expect(oxy.webauthnRegisterVerify(CREATE_RESPONSE)).rejects.toThrow();
    expect(setTokens).not.toHaveBeenCalled();
  });
});

describe('webauthnLoginVerify', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;
  let setTokens: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
    setTokens = jest.spyOn(oxy, 'setTokens').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('parses LoginSessionResult, plants the token, and threads the device envelope', async () => {
    makeRequest.mockResolvedValueOnce(SESSION_ARM);
    const result = await oxy.webauthnLoginVerify(GET_RESPONSE, {
      deviceName: 'Phone',
      deviceFingerprint: 'fp-1',
    });
    expect(result).toEqual(SESSION_ARM);
    expect('twoFactorRequired' in result).toBe(false);
    if (!('twoFactorRequired' in result)) {
      expect(result.deviceId).toBe('dev-1');
      expect(result.deviceSecret).toBe('ds-secret-1');
    }
    expect(setTokens).toHaveBeenCalledWith('access-1');
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/login/verify',
      { response: GET_RESPONSE, deviceName: 'Phone', deviceFingerprint: 'fp-1' },
      { cache: false, skipAuth: true },
    );
  });

  it('POSTs the bare response body when no envelope is passed', async () => {
    makeRequest.mockResolvedValueOnce(SESSION_ARM);
    await oxy.webauthnLoginVerify(GET_RESPONSE);
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/webauthn/login/verify',
      { response: GET_RESPONSE },
      { cache: false, skipAuth: true },
    );
  });

  it('throws on an unexpected response shape', async () => {
    makeRequest.mockResolvedValueOnce({ nope: true });
    await expect(oxy.webauthnLoginVerify(GET_RESPONSE)).rejects.toThrow();
    expect(setTokens).not.toHaveBeenCalled();
  });
});

describe('deleting a passkey account', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'makeRequest');
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks for the options, then deletes with the assertion and the confirmation', async () => {
    makeRequest.mockResolvedValueOnce({ challenge: 'c' }).mockResolvedValueOnce({ message: 'deleted' });

    await expect(oxy.getAccountDeletionOptions()).resolves.toEqual({ challenge: 'c' });
    await expect(oxy.deleteAccountWithPasskey('ada', GET_RESPONSE)).resolves.toEqual({ message: 'deleted' });

    expect(makeRequest).toHaveBeenNthCalledWith(1, 'POST', '/users/me/delete/options', undefined, { cache: false });
    expect(makeRequest).toHaveBeenNthCalledWith(2, 'DELETE', '/users/me', { confirmText: 'ada', assertion: GET_RESPONSE }, { cache: false });
  });
});
