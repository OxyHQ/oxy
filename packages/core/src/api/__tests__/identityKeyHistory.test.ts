/**
 * `oxy.identity.keyHistory()` — what Commons reads to accept a previous recovery
 * phrase: the request it sends and the answer it trusts. `request` is stubbed.
 */
import { OxyServices } from '../../OxyServices';

const key = (fill: string) => `04${fill.repeat(128)}`;

describe('identity.keyHistory', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'request');
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads GET /identity/key-history uncached and answers the checked history', async () => {
    const history = {
      publicKey: key('c'),
      retired: [
        { publicKey: key('a'), retiredAt: '2026-11-01T10:00:00.000Z' },
        { publicKey: key('b'), retiredAt: '2026-11-05T10:00:00.000Z' },
      ],
    };
    makeRequest.mockResolvedValueOnce(history);

    await expect(oxy.identity.keyHistory()).resolves.toEqual(history);
    expect(makeRequest).toHaveBeenCalledWith('GET', '/identity/key-history', undefined, {
      cache: false,
    });
  });

  it('refuses an answer that is not the contract, rather than trusting a key in it', async () => {
    makeRequest.mockResolvedValueOnce({
      publicKey: key('c'),
      retired: [{ publicKey: `02${'a'.repeat(64)}`, retiredAt: '2026-11-01T10:00:00.000Z' }],
    });
    await expect(oxy.identity.keyHistory()).rejects.toThrow('unexpected response shape');
  });
});

const mockQuarantined: string[] = [];
const mockSign = jest.fn(
  async (publicKey: string, message: string) => `sig:${publicKey}:${message}`,
);
jest.mock('../../crypto/retiredKeys', () => ({
  ...jest.requireActual('../../crypto/retiredKeys'),
  listQuarantinedIdentityKeys: async () => [...mockQuarantined],
  signWithQuarantinedIdentityKey: (publicKey: string, message: string) =>
    mockSign(publicKey, message),
}));

describe('identity.claimQuarantinedKeys (R6-5)', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(async () => {
    (await import('../../utils/platform')).setPlatformOS('ios');
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequest = jest.spyOn(oxy, 'request');
    jest.spyOn(oxy.session, 'userId', 'get').mockReturnValue('user-1');
    mockQuarantined.length = 0;
    mockSign.mockClear();
  });
  afterEach(async () => {
    (await import('../../utils/platform')).setPlatformOS('web');
    jest.restoreAllMocks();
  });

  it('puts each unnamed quarantined key to Oxy with a possession proof, and answers the history Oxy returns', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    mockQuarantined.push(key('d'), key('e'));
    const before = { publicKey: key('c'), retired: [] };
    const after = {
      publicKey: key('c'),
      retired: [{ publicKey: key('d'), retiredAt: '2025-01-01T00:00:00.000Z' }],
    };
    makeRequest
      .mockResolvedValueOnce(after)
      .mockRejectedValueOnce(Object.assign(new Error('not proven'), { status: 404 }));

    await expect(oxy.identity.claimQuarantinedKeys(before)).resolves.toEqual(after);
    const message = JSON.stringify({
      action: 'claim_retired_identity_key',
      userId: 'user-1',
      publicKey: key('d'),
      timestamp: 1_700_000_000_000,
    });
    expect(makeRequest).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/identity/key-history/claim',
      {
        publicKey: key('d'),
        signature: `sig:${key('d')}:${message}`,
        timestamp: 1_700_000_000_000,
      },
      { cache: false },
    );
    expect(makeRequest).toHaveBeenCalledTimes(2);

    // Each key is put to Oxy once per process: nothing is asked again.
    makeRequest.mockClear();
    await oxy.identity.claimQuarantinedKeys(after);
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it('asks nothing for a key the history already names, and stops at a failure it can retry', async () => {
    mockQuarantined.push(key('a'), key('f'), key('7'));
    makeRequest.mockRejectedValueOnce(new Error('offline'));
    const history = {
      publicKey: key('c'),
      retired: [{ publicKey: key('a'), retiredAt: '2025-01-01T00:00:00.000Z' }],
    };
    await expect(oxy.identity.claimQuarantinedKeys(history)).resolves.toEqual(history);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(mockSign).not.toHaveBeenCalledWith(key('a'), expect.any(String));
    // Retried on a later run.
    makeRequest.mockRejectedValue(Object.assign(new Error('not proven'), { status: 404 }));
    await oxy.identity.claimQuarantinedKeys(history);
    expect(makeRequest).toHaveBeenCalledTimes(3);
  });
});
