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
