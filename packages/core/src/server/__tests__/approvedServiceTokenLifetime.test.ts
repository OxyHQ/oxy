import { OxyServer } from '../OxyServer';
import { hasBoundedServiceTokenLifetime } from '../serviceTokenLifetime';

const token = (lifetime: number) => {
  const iat = Math.floor(Date.now() / 1000);
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ iat, exp: iat + lifetime })).toString('base64url')}.signature`;
};

afterEach(() => jest.restoreAllMocks());

it.each([300, 1])('allows positive lifetime %i seconds', (seconds) => {
  expect(hasBoundedServiceTokenLifetime({ iat: 100, exp: 100 + seconds }, 100)).toBe(true);
});
it.each([
  { iat: 100, exp: 401 }, { iat: 100, exp: 3700 }, { iat: 101, exp: 400 },
  { exp: 400 }, { iat: 100, exp: 100 }, { iat: 100.5, exp: 400 },
])('rejects an unbounded or invalid lifetime %j', (claims) => {
  expect(hasBoundedServiceTokenLifetime(claims, 100)).toBe(false);
});

it('remints a cached hour token before returning it to a caller', async () => {
  const server = new OxyServer({ baseURL: 'https://test.invalid', serviceAuth: { apiKey: 'key', apiSecret: 'secret' } });
  const cache = (server as unknown as { serviceTokens: Map<string, unknown> }).serviceTokens;
  cache.set('key', { token: token(3600), expiresAt: Date.now() + 3600_000,
    secretBuf: Buffer.from('secret'), pending: null, apiKey: 'key' });
  const fresh = token(300);
  const request = jest.spyOn(server as unknown as { request: jest.Mock }, 'request')
    .mockResolvedValue({ token: fresh, expiresIn: 300 });
  expect(await server.serviceToken()).toBe(fresh);
  expect(await server.serviceToken()).toBe(fresh);
  expect(request).toHaveBeenCalledTimes(1);
});


it('remints an expired bounded token even if the mint response reported a longer cache duration', async () => {
  const server = new OxyServer({ baseURL: 'https://test.invalid', serviceAuth: { apiKey: 'key', apiSecret: 'secret' } });
  const now = Math.floor(Date.now() / 1000);
  const stale = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ iat: now - 301, exp: now - 1 })).toString('base64url')}.signature`;
  (server as unknown as { serviceTokens: Map<string, unknown> }).serviceTokens.set('key', {
    token: stale, expiresAt: Date.now() + 3600_000, secretBuf: Buffer.from('secret'), pending: null, apiKey: 'key' });
  const fresh = token(300);
  jest.spyOn(server as unknown as { request: jest.Mock }, 'request').mockResolvedValue({ token: fresh, expiresIn: 300 });
  expect(await server.serviceToken()).toBe(fresh);
});
