/**
 * `mintFromDeviceSecret` — the pinned (identity-bound) mint.
 *
 * The pinned form adds `accountId` to the zero-cookie mint body so an identity
 * vault gets ITS account's token without the device's `activeAccountId` being
 * touched. Its one new failure mode — `401 account_not_on_device` — must be
 * distinguishable from a bad device secret, because the remedies are opposite:
 * a bad secret is dropped, a stale identity binding is re-established while the
 * (healthy) secret is kept.
 */
import { OxyServices } from '../../OxyServices';
import { AccountNotOnDeviceError } from '../devices';

const MINT_RESPONSE = {
  accessToken: 'access-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  nextDeviceSecret: 'ds-next',
  state: {
    deviceId: 'dev-1',
    accounts: [{ accountId: 'vault-user', sessionId: 'sess-vault', authuser: 0 }],
    activeAccountId: 'other-user',
    revision: 3,
    updatedAt: 1_700_000_000_000,
  },
};

describe('OxyServices.mintFromDeviceSecret', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'request');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('omits accountId from the body when unpinned', async () => {
    makeRequestSpy.mockResolvedValue(MINT_RESPONSE);

    await oxy.devices.mintToken('dev-1', 'ds-1');

    expect(makeRequestSpy).toHaveBeenCalledWith(
      'POST',
      '/session/device/token',
      { deviceId: 'dev-1', deviceSecret: 'ds-1' },
      expect.objectContaining({ cache: false, skipAuth: true, retry: false, bypassQueue: true }),
    );
  });

  it('sends accountId when pinned', async () => {
    makeRequestSpy.mockResolvedValue(MINT_RESPONSE);

    const mint = await oxy.devices.mintToken('dev-1', 'ds-1', { accountId: 'vault-user' });

    expect(makeRequestSpy).toHaveBeenCalledWith(
      'POST',
      '/session/device/token',
      { deviceId: 'dev-1', deviceSecret: 'ds-1', accountId: 'vault-user' },
      expect.anything(),
    );
    // The response still reports the device's TRUE active account — a pinned
    // mint never mutates it.
    expect(mint.state.activeAccountId).toBe('other-user');
  });

  it('maps a 401 account_not_on_device to the typed AccountNotOnDeviceError', async () => {
    makeRequestSpy.mockRejectedValue(
      Object.assign(new Error('account_not_on_device'), { status: 401, code: 'UNAUTHORIZED' }),
    );

    const error = await oxy
      .devices.mintToken('dev-1', 'ds-1', { accountId: 'vault-user' })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(AccountNotOnDeviceError);
    expect(error).toMatchObject({ name: 'AccountNotOnDeviceError', accountId: 'vault-user', status: 401 });
  });

  it('leaves every OTHER 401 as an ordinary error (a bad secret is not an identity problem)', async () => {
    makeRequestSpy.mockRejectedValue(
      Object.assign(new Error('invalid_device_secret'), { status: 401, code: 'UNAUTHORIZED' }),
    );

    const error = await oxy
      .devices.mintToken('dev-1', 'ds-1', { accountId: 'vault-user' })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).not.toBeInstanceOf(AccountNotOnDeviceError);
    expect(error).toMatchObject({ message: 'invalid_device_secret', status: 401 });
  });

  it('does not classify an UNPINNED mint failure as account_not_on_device', async () => {
    makeRequestSpy.mockRejectedValue(
      Object.assign(new Error('account_not_on_device'), { status: 401, code: 'UNAUTHORIZED' }),
    );

    const error = await oxy.devices.mintToken('dev-1', 'ds-1').then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeInstanceOf(AccountNotOnDeviceError);
  });
});
