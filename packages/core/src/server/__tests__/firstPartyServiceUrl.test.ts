import { OxyServer } from '../OxyServer';

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => false,
  requestWorkloadServiceToken: jest.fn(),
}));

describe('OxyServer.isFirstPartyServiceUrl', () => {
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  afterAll(() => oxy.dispose());

  it.each([
    'https://api.oxy.so/billing/peable/events',
    'https://API.OXY.SO/billing/peable/events',
    'https://api.oxy.so:443/billing/peable/events',
    'https://api.oxy.so',
    new URL('https://api.oxy.so/x?y=1'),
  ])('is true for the configured Oxy API origin: %s', (url) => {
    expect(oxy.isFirstPartyServiceUrl(url)).toBe(true);
  });

  it.each([
    // Look-alikes and other hosts are never first-party, whatever they resolve to.
    'https://api.oxy.so.evil.com/billing/peable/events',
    'https://evil.com/api.oxy.so',
    'https://evilapi.oxy.so.com/',
    'https://api-oxy.so/',
    'https://api.oxy.so./billing/peable/events',
    // Another official Oxy host is not this server's service.
    'https://auth.oxy.so/',
    'https://api.mention.earth/',
    // Same host, different origin.
    'http://api.oxy.so/billing/peable/events',
    'https://api.oxy.so:8443/billing/peable/events',
    // Credentials, other schemes, garbage.
    'https://user:pass@api.oxy.so/',
    'https://user@api.oxy.so/',
    'ftp://api.oxy.so/',
    'not a url',
    '',
    'http://127.0.0.1:9/ssrf',
    'http://localhost/',
  ])('is false for %s', (url) => {
    expect(oxy.isFirstPartyServiceUrl(url)).toBe(false);
  });

  it('is false for every URL when the configured API origin is not an official Oxy origin', () => {
    const elsewhere = new OxyServer({ baseURL: 'https://api.example.com' });
    expect(elsewhere.isFirstPartyServiceUrl('https://api.example.com/hook')).toBe(false);
    expect(elsewhere.isFirstPartyServiceUrl('https://api.oxy.so/hook')).toBe(false);
    elsewhere.dispose();
  });

  it('follows the configured origin, so a local Oxy API is first-party only to a server configured for it', () => {
    const local = new OxyServer({ baseURL: 'http://localhost:3001' });
    expect(local.isFirstPartyServiceUrl('http://localhost:3001/billing/peable/events')).toBe(true);
    expect(local.isFirstPartyServiceUrl('http://localhost:3002/')).toBe(false);
    expect(local.isFirstPartyServiceUrl('https://api.oxy.so/')).toBe(false);
    local.dispose();
  });

  it('names a URL its own service client accepts', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const client = oxy.createServiceClient({ baseURL: oxy.baseURL, audience: 'oxy-api' });
    const url = 'https://api.oxy.so/billing/peable/events';
    expect(oxy.isFirstPartyServiceUrl(url)).toBe(true);
    await expect(client.fetch('https://api.oxy.so.evil.com/x')).rejects.toThrow(
      'configured API origin',
    );
    client.dispose();
    fetch.mockRestore();
  });
});
