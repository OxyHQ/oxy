/**
 * `OxyServer.accounts.accessFor` — the service-lane membership verdict.
 *
 * Stubs `serviceRequest` (the service-token transport) so these run with no
 * network. What is guarded is the caller's safety, not the transport: every
 * call goes to the API (no cache, so a removed member loses the right on the
 * next call), and anything but a valid verdict THROWS, so an outage can never
 * read as "yes" — nor as a "no" a caller then remembers.
 */

import type { AccountAccessVerdict } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';
import { OxyServer } from '../OxyServer';
import { ServerAccountsApi } from '../namespaces';

const member: AccountAccessVerdict = {
  accountId: 'channel-1',
  kind: 'channel',
  access: {
    role: 'editor',
    permissions: ['account:read'],
    status: 'active',
    source: 'direct',
  },
};

function statusError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, response: { status } });
}

describe('OxyServer.accounts.accessFor', () => {
  let oxy: OxyServer;
  let serviceRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    serviceRequest = jest.spyOn(oxy, 'serviceRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is the server-side accounts namespace, keeping the client methods', () => {
    expect(oxy.accounts).toBeInstanceOf(ServerAccountsApi);
    expect(oxy.accounts).toBe(oxy.accounts);
    expect(typeof oxy.accounts.list).toBe('function');
    expect(oxy.accounts.members).toBeDefined();
  });

  it('GETs the internal verdict with both ids encoded, uncached', async () => {
    serviceRequest.mockResolvedValueOnce(member);

    await expect(oxy.accounts.accessFor('channel-1', 'user/1')).resolves.toEqual(member);

    expect(serviceRequest).toHaveBeenCalledWith(
      'GET',
      '/internal/accounts/channel-1/access/user%2F1',
      undefined,
      { cache: false },
    );
  });

  it('asks again on every call: nothing is cached', async () => {
    serviceRequest.mockResolvedValueOnce(member).mockResolvedValueOnce({ ...member, access: null });

    await expect(oxy.accounts.accessFor('channel-1', 'user-1')).resolves.toEqual(member);
    await expect(oxy.accounts.accessFor('channel-1', 'user-1')).resolves.toEqual({
      ...member,
      access: null,
    });
    expect(serviceRequest).toHaveBeenCalledTimes(2);
  });

  it('returns a refusal as a verdict, not as an error', async () => {
    serviceRequest.mockResolvedValueOnce({ accountId: 'channel-1', kind: null, access: null });

    await expect(oxy.accounts.accessFor('channel-1', 'user-1')).resolves.toEqual({
      accountId: 'channel-1',
      kind: null,
      access: null,
    });
  });

  it.each([401, 403, 404, 429, 500, 503])(
    'throws on %i, so the caller fails closed',
    async (status) => {
      serviceRequest.mockRejectedValueOnce(statusError(status));

      await expect(oxy.accounts.accessFor('channel-1', 'user-1')).rejects.toThrow(`HTTP ${status}`);
    },
  );

  it.each([
    ['an empty body (a 204)', undefined],
    ['a body without a verdict', { ok: true }],
    ['access over an account that does not exist', { ...member, kind: null }],
    ['a non-active membership', { ...member, access: { ...member.access, status: 'invited' } }],
    ['a verdict about a different account', { ...member, accountId: 'channel-2' }],
  ])('throws on %s', async (_label, body) => {
    serviceRequest.mockResolvedValueOnce(body);

    await expect(oxy.accounts.accessFor('channel-1', 'user-1')).rejects.toThrow(
      'Invalid account access verdict',
    );
  });

  it('refuses empty ids without a request', async () => {
    await expect(oxy.accounts.accessFor('', 'user-1')).rejects.toThrow();
    await expect(oxy.accounts.accessFor('channel-1', '')).rejects.toThrow();
    expect(serviceRequest).not.toHaveBeenCalled();
  });

  it('does not exist on a plain client, which has no service credential', () => {
    const plain = new OxyServices({ baseURL: 'http://test.invalid' });
    expect('accessFor' in plain.accounts).toBe(false);
  });
});
