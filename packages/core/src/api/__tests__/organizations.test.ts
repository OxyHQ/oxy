import { OxyServices } from '../../OxyServices';
const organization = {
  accountId: 'org-id',
  username: 'companyname',
  name: '3M',
  organizationType: 'business',
  avatar: null,
  legalName: null,
  websiteUrl: null,
  countryCode: null,
  aliases: [],
  verifiedDomains: [],
  claimStatus: 'unclaimed',
  status: 'active',
  mergedIntoAccountId: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
describe('oxy.organizations', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let oxy: OxyServices;
  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  it('reads canonical public identities without requiring a login and never caches visibility decisions', async () => {
    fetchMock.mockImplementation(async () => response(organization));
    expect(await oxy.organizations.get('org-id')).toEqual(organization);
    await oxy.organizations.get('org-id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
  });
  it('parses batch redirect attribution and missing identifiers', async () => {
    const result = {
      items: [{ requestedAccountId: 'old-id', organization }],
      missingIds: ['missing'],
    };
    fetchMock.mockResolvedValue(response(result));
    expect(await oxy.organizations.batch({ ids: ['old-id', 'missing'] })).toEqual(result);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ids: ['old-id', 'missing'] });
  });
  it('rejects malformed directory responses and preserves typed not-found errors', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...organization, organizationType: 'personal' }));
    await expect(oxy.organizations.get('org-id')).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(
      response({ error: { code: 'not_found', message: 'Organization not found' } }, 404),
    );
    await expect(oxy.organizations.get('missing')).rejects.toMatchObject({ status: 404 });
  });
  it('evicts canonical identity reads after a directory name update', async () => {
    oxy.session.setAccessToken('test-bearer');
    const invalidate = jest.spyOn(oxy.http, 'invalidateCache');
    fetchMock.mockResolvedValue(response({ ...organization, name: '7-Eleven' }));
    await oxy.organizations.update('org-id', { name: '7-Eleven' });
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ['GET:/users/org-id'] }),
    );
  });
  it('does not permit application imports through a browser user bearer', async () => {
    await expect(
      oxy.organizations.importBatch({
        namespace: 'homiio',
        items: [
          {
            externalId: '1',
            organization: { name: 'Company', organizationType: 'business' },
            evidenceReference: 'proof',
          },
        ],
      }),
    ).rejects.toThrow('OxyServer service identity');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
