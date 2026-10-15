import { OxyServices } from '../../OxyServices';
import { OxyServer } from '../../server/OxyServer';
const decision = { allowed: false, reason: 'private', policyVersion: '1' };
describe('canonical profile access context', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify(decision), { headers: { 'content-type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  it('requires explicit requester context on a server and never silently substitutes service identity', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    await expect(oxy.safety.profileAccess({ subjectAccountId: 'subject' })).rejects.toThrow(
      'explicit requester',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await oxy.safety.profileAccess({ subjectAccountId: 'subject' }, { accessToken: null }),
    ).toEqual(decision);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('authorization')).toBe(false);
  });
  it('forwards exactly the original bearer when supplied and does not refresh into another account', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    expect(
      await oxy.safety.profileAccess(
        { subjectAccountId: 'subject' },
        { accessToken: 'original-bearer' },
      ),
    ).toEqual(decision);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('authorization')).toBe(
      'Bearer original-bearer',
    );
  });
  it('rejects caller-selected viewer IDs and malformed policy answers', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    await expect(
      oxy.safety.profileAccess({ subjectAccountId: 'subject', viewerId: 'forged' } as never, {
        accessToken: null,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ allowed: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      oxy.safety.profileAccess({ subjectAccountId: 'subject' }, { accessToken: null }),
    ).rejects.toThrow();
  });
});
