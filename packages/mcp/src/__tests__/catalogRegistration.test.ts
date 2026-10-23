import type { AppCapabilityCatalog } from '@oxy.so/contracts';
import { capabilityCatalogDigest, registerCapabilityCatalog } from '../catalogRegistration';
import { OxyMcpRequestError } from '../serviceRequest';

const catalog: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'homiio',
  version: '1.0.0',
  audience: 'homiio-api',
  internalBaseUrl: 'https://api.homiio.com',
  accountResourceType: 'homiio_account',
  internalTransport: 'mcp',
  tools: [
    {
      name: 'searchListings',
      version: '1.0.0',
      description: 'Search listings.',
      inputSchema: { type: 'object' },
      capabilityPackage: 'read',
      requiredCapabilities: ['listings.read'],
      resourceTypes: ['homiio_account'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['internal', 'mcp'],
      limitKeys: [],
      invocation: { method: 'GET', path: '/listings' },
    },
  ],
  events: [],
};

function respond(status: number, body: unknown) {
  return jest.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('registerCapabilityCatalog', () => {
  it('registers the served catalogue and returns the binding for its exact bytes', async () => {
    const digest = capabilityCatalogDigest(catalog);
    const fetcher = respond(201, { registration: { id: 'reg-1', version: '1.0.0', digest } });
    await expect(
      registerCapabilityCatalog(catalog, {
        oxyApiUrl: 'https://api.oxy.so//',
        getServiceToken: async () => 'service-token',
        fetch: fetcher,
        deployedAt: new Date('2026-10-16T10:00:00.000Z'),
      }),
    ).resolves.toEqual({ registrationId: 'reg-1', version: '1.0.0', digest });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.oxy.so/capabilities/catalogs/register');
    expect(JSON.parse(String(init.body))).toEqual({
      catalog,
      deployedAt: '2026-10-16T10:00:00.000Z',
    });
  });

  it('refuses a registration that is not this catalogue', async () => {
    const fetcher = respond(201, {
      registration: { id: 'reg-1', version: '1.0.0', digest: 'f'.repeat(64) },
    });
    await expect(
      registerCapabilityCatalog(catalog, {
        oxyApiUrl: 'https://api.oxy.so',
        getServiceToken: async () => 'service-token',
        fetch: fetcher,
      }),
    ).rejects.toThrow('Oxy registered a different catalogue');
  });

  it("carries Oxy's refusal message, not just its status", async () => {
    const fetcher = respond(400, {
      error: 'catalog_registration_failed',
      message: 'features.0.checkTool: checkTool must name an internal-only read tool',
    });
    const failure = registerCapabilityCatalog(catalog, {
      oxyApiUrl: 'https://api.oxy.so',
      getServiceToken: async () => 'service-token',
      fetch: fetcher,
    });
    await expect(failure).rejects.toBeInstanceOf(OxyMcpRequestError);
    await expect(failure).rejects.toMatchObject({
      status: 400,
      code: 'catalog_registration_failed',
      message: 'features.0.checkTool: checkTool must name an internal-only read tool',
    });
  });

  it('never sends a catalogue the contract refuses', async () => {
    const fetcher = respond(201, {});
    await expect(
      registerCapabilityCatalog(
        { ...catalog, internalTransport: 'grpc' } as unknown as AppCapabilityCatalog,
        { oxyApiUrl: 'https://api.oxy.so', getServiceToken: async () => 't', fetch: fetcher },
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it('uses an injected authenticated transport without a token callback or a second refresh loop', async () => {
  const fetch = respond(201, {
    registration: { id: 'own', version: catalog.version, digest: capabilityCatalogDigest(catalog) },
  });
  const transport = { fetch };
  await expect(
    registerCapabilityCatalog(catalog, { oxyApiUrl: 'https://api.oxy.so', transport }),
  ).resolves.toMatchObject({ registrationId: 'own' });
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
  });
  expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
});
