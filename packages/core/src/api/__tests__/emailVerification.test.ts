/**
 * The sign-up email code (`oxy.auth.email.startVerification` /
 * `confirmVerification`): signed out, parsed against the contract.
 */
import { OxyServices } from '../../OxyServices';

describe('email verification', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'request');
  });
  afterEach(() => jest.restoreAllMocks());

  it('starts a verification signed out and parses its id', async () => {
    makeRequest.mockResolvedValueOnce({ verificationId: 'v-1', expiresAt: 1_900_000_000_000 });
    await expect(oxy.auth.email.startVerification({ purpose: 'signup', email: 'ada@example.com' })).resolves.toEqual({
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
    const confirmed = { ticket: 'T'.repeat(43), expiresAt: 1_900_000_000_000 };
    makeRequest.mockResolvedValueOnce(confirmed);
    await expect(oxy.auth.email.confirmVerification('v-1', '123456')).resolves.toEqual(confirmed);
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/email/verify/confirm',
      { verificationId: 'v-1', code: '123456' },
      { cache: false, skipAuth: true },
    );
  });

  it('refuses a malformed answer rather than handing on a ticket it cannot read', async () => {
    makeRequest.mockResolvedValueOnce({ ticket: 'short', expiresAt: 1 });
    await expect(oxy.auth.email.confirmVerification('v-1', '123456')).rejects.toThrow();
  });
});
