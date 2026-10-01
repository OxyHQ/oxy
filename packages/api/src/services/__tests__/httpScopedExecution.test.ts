import { generateKeyPairSync } from 'node:crypto';
import { createHttpKaanaClient, createHttpKaanaCatalogueReader } from '../httpKaanaClient';
import { resolveKaanaDataPlane } from '../../config/kaanaDataPlane';
jest.mock('../../config/kaanaDataPlane', () => ({ resolveKaanaDataPlane: jest.fn(), kaanaPublicKeyBase64: jest.fn() }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
beforeEach(() => {
  const keys = generateKeyPairSync('ed25519');
  jest.mocked(resolveKaanaDataPlane).mockReturnValue({ status: 'configured', config: { baseUrl: 'https://kaana.ai', keyId: 'synthetic', privateKey: keys.privateKey } });
});
afterEach(() => jest.restoreAllMocks());
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } });
it('sends explicit signed-body negotiation and requires the positive exact echo', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://kaana.ai/internal/v1/deployments/query');
    expect(JSON.parse((init?.body as Buffer).toString())).toEqual({ deploymentIds: ['synthetic'], scopedExecutionContractVersion: '3.6.0' });
    expect((init?.headers as Record<string, string>)['X-Oxy-Kaana-Signature']).toMatch(/^v1=/);
    return response({ snapshotId: 'synthetic', deployments: [], scopedExecutionContractVersion: '3.6.0' });
  });
  const client = createHttpKaanaClient()!;
  await expect(client.attestDeployments(['synthetic'], { signal: new AbortController().signal, scopedExecutionContractVersion: '3.6.0' })).resolves.toMatchObject({ scopedExecutionContractVersion: '3.6.0' });
  fetcher.mockResolvedValue(response({ snapshotId: 'synthetic', deployments: [] }));
  await expect(client.attestDeployments(['synthetic'], { signal: new AbortController().signal, scopedExecutionContractVersion: '3.6.0' })).rejects.toThrow('acknowledge');
});
it('keeps the ordinary exact query legacy bytes unchanged', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
    expect((init?.body as Buffer).toString()).toBe('{"deploymentIds":["synthetic"]}');
    return response({ snapshotId: 'synthetic', deployments: [] });
  });
  await expect(createHttpKaanaClient()!.attestDeployments(['synthetic'], { signal: new AbortController().signal })).resolves.toMatchObject({ snapshotId: 'synthetic' });
});
it('reads the full catalogue through the existing signer and rejects missing support', async () => {
  const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://kaana.ai/internal/v1/models/query');
    expect(init?.method).toBe('POST');
    expect((init?.body as Buffer).toString()).toBe('{"scopedExecutionContractVersion":"3.6.0"}');
    return response({ models: [], scopedExecutionContractVersion: '3.6.0' });
  });
  const reader = createHttpKaanaCatalogueReader()!;
  await expect(reader.listModels(new AbortController().signal)).resolves.toMatchObject({ scopedExecutionContractVersion: '3.6.0' });
  fetcher.mockResolvedValue(response({ models: [] }));
  await expect(reader.listModels(new AbortController().signal)).rejects.toThrow();
});
