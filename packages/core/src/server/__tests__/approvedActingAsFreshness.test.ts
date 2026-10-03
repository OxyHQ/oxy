import { OxyServer } from '../OxyServer';

type VerifyOptions = { cache?: boolean };
const verify = (server: OxyServer, options?: VerifyOptions) =>
  (server.verifyActingAs as (app: string, user: string, options?: VerifyOptions) => Promise<unknown>)('app', 'user', options);
const grant = (epoch: string) => ({ authorized: true, scopes: ['user:read'], epoch });

function fixture() {
  const server = new OxyServer({ baseURL: 'https://test.invalid' });
  jest.spyOn(server, 'serviceToken').mockResolvedValue('verifier');
  const request = jest.spyOn(server as unknown as { request: jest.Mock }, 'request');
  return { server, request };
}

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it('default verification revalidates an effect after revocation instead of reusing a positive read', async () => {
  const { server, request } = fixture();
  request.mockResolvedValueOnce(grant('1')).mockResolvedValueOnce({ authorized: false, scopes: [], epoch: '2' });
  expect(await verify(server)).not.toBeNull();
  expect(await verify(server)).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});

it('explicit read cache expires positive authority at 60 seconds, anchored to request start', async () => {
  jest.useFakeTimers();
  const { server, request } = fixture();
  request.mockResolvedValueOnce(grant('1')).mockResolvedValueOnce({ authorized: false, scopes: [], epoch: '2' });
  expect(await verify(server, { cache: true })).not.toBeNull();
  jest.advanceTimersByTime(60_000);
  expect(await verify(server, { cache: true })).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});

it('explicit read denial lasts at most 10 seconds', async () => {
  jest.useFakeTimers();
  const { server, request } = fixture();
  request.mockResolvedValueOnce({ authorized: false, scopes: [], epoch: '1' }).mockResolvedValueOnce(grant('2'));
  expect(await verify(server, { cache: true })).toBeNull();
  jest.advanceTimersByTime(10_000);
  expect(await verify(server, { cache: true })).not.toBeNull();
});

it('a verifier failure does not poison immediate recovery with a negative cache', async () => {
  const { server, request } = fixture();
  request.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(grant('1'));
  expect(await verify(server, { cache: true })).toBeNull();
  expect(await verify(server, { cache: true })).not.toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});

it('an older in-flight grant cannot resurrect authority after a newer revoked epoch', async () => {
  const { server, request } = fixture();
  let complete!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
    .mockResolvedValueOnce({ authorized: false, scopes: [], epoch: '2' });
  const pending = verify(server);
  await Promise.resolve(); await Promise.resolve();
  const revoked = verify(server);
  await Promise.resolve(); await Promise.resolve();
  complete(grant('1'));
  expect(await revoked).toBeNull();
  expect(await pending).toBeNull();
});

it('a delayed effect response is denied rather than measured as a revocation guarantee', async () => {
  jest.useFakeTimers();
  const { server, request } = fixture();
  let complete!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const pending = verify(server);
  await Promise.resolve(); await Promise.resolve();
  jest.advanceTimersByTime(5_000);
  complete(grant('1'));
  expect(await pending).toBeNull();
});


it('a delayed positive cannot replace a newer denial with the same durable epoch', async () => {
  const { server, request } = fixture();
  let complete!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
    .mockResolvedValueOnce({ authorized: false, scopes: [], epoch: '7' });
  const pending = verify(server, { cache: true });
  await Promise.resolve(); await Promise.resolve();
  expect(await verify(server)).toBeNull();
  complete(grant('7'));
  expect(await pending).toBeNull();
  request.mockResolvedValueOnce({ authorized: false, scopes: [], epoch: '7' });
  expect(await verify(server, { cache: true })).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([
  { authorized: 'true', scopes: ['user:read'], epoch: '1' },
  { authorized: 1, scopes: ['user:read'], epoch: '1' },
  { authorized: true, scopes: [3], epoch: '1' },
  { authorized: false, scopes: ['user:read'], epoch: '1' },
  { authorized: true, scopes: [' user:read'], epoch: '1' },
  { authorized: true, scopes: ['user:read', 'user:read'], epoch: '1' },
])('does not cache a malformed authority response: %j', async (malformed) => {
  const { server, request } = fixture();
  request.mockResolvedValueOnce(malformed).mockResolvedValueOnce(grant('2'));
  expect(await verify(server, { cache: true })).toBeNull();
  expect(await verify(server, { cache: true })).not.toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});
