/**
 * `createInferenceClient(oxy)`: the client must use THIS client's origin and
 * read the bearer LATE, so a token planted after creation (the cold-boot order)
 * is the one sent.
 */
import { OxyServices } from '../../OxyServices';
import { createInferenceClient, OxyInferenceClient } from '../../inference';

describe('createInferenceClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [], count: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  });

  afterEach(() => fetchSpy.mockRestore());

  it('binds the base URL and reads the bearer at request time', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    const client = createInferenceClient(oxy);
    expect(client).toBeInstanceOf(OxyInferenceClient);

    oxy.session.setAccessToken('planted-later');
    await client.listModels();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://test.invalid/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer planted-later');
  });
});
