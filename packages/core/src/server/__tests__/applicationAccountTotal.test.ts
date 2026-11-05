import { OxyServer } from '../OxyServer';

const snapshot = {
  schemaVersion: 1,
  applicationId: 'synthetic-app',
  total: 7,
  exact: true,
  computedAt: '2026-11-02T00:00:00.000Z',
  maxAgeSeconds: 300,
  stale: false,
};

it('reads the total and registers accounts over the workload lane only', async () => {
  const server = new OxyServer({ baseURL: 'https://synthetic.invalid' });
  const service = jest
    .spyOn(server, 'serviceRequest')
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ registered: 2 });
  await expect(server.applicationAccountTotal()).resolves.toEqual(snapshot);
  await expect(server.registerApplicationAccounts(['a', 'b'])).resolves.toBe(2);
  expect(service.mock.calls[0].slice(0, 2)).toEqual(['GET', '/application-accounts/self/total']);
  expect(service.mock.calls[1].slice(0, 3)).toEqual([
    'POST',
    '/application-accounts/self/registrations',
    { accountIds: ['a', 'b'] },
  ]);
});

it('rejects a malformed answer and an oversized batch instead of inventing a number', async () => {
  const server = new OxyServer({ baseURL: 'https://synthetic.invalid' });
  jest.spyOn(server, 'serviceRequest').mockResolvedValue({ ...snapshot, total: null });
  await expect(server.applicationAccountTotal()).rejects.toThrow();
  await expect(
    server.registerApplicationAccounts(Array.from({ length: 501 }, (_, i) => `a${i}`)),
  ).rejects.toThrow();
});
