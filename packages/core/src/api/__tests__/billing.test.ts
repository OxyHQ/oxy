import { stubbedClient } from './helpers';

describe('oxy.billing', () => {
  it('defaults every read to the signed-in user', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({ plan: 'basic' });
    await oxy.billing.subscription();
    expect(request).toHaveBeenLastCalledWith('GET', '/subscription/me', undefined, { cache: true, cacheTTL: 120000 });

    request.mockResolvedValue({ userId: 'me', balance: 1, address: null });
    await oxy.billing.wallet();
    expect(request).toHaveBeenLastCalledWith('GET', '/wallet/me', undefined, { cache: true, cacheTTL: 60000 });
  });

  it('reads another user when one is named', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({ plan: 'pro' });
    await oxy.billing.subscription('other');
    expect(request).toHaveBeenLastCalledWith('GET', '/subscription/other', undefined, expect.anything());
  });

  it('pages wallet transactions through query params, never cached', async () => {
    const { oxy, request } = stubbedClient('me');
    const page = { data: [], pagination: { total: 0, limit: 5, offset: 10, hasMore: false } };
    request.mockResolvedValue(page);
    await expect(oxy.billing.walletTransactions({ limit: 5, offset: 10 })).resolves.toBe(page);
    expect(request).toHaveBeenLastCalledWith('GET', '/wallet/transactions/me', { limit: 5, offset: 10 }, { cache: false });
  });

  it('reads the payment history uncached', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue([]);
    await oxy.billing.payments();
    expect(request).toHaveBeenLastCalledWith('GET', '/payments/user', undefined, { cache: false });
  });

  it('throws before any request when signed out and no user is named', async () => {
    const { oxy, request } = stubbedClient();
    await expect(oxy.billing.wallet()).rejects.toThrow('User not authenticated');
    expect(request).not.toHaveBeenCalled();
  });
});
