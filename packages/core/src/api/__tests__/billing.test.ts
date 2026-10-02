import { stubbedClient } from './helpers';

describe('oxy.billing', () => {
  it('queries explicit product rights uncached and parses the access-only response', async () => {
    const { oxy, request } = stubbedClient('me');
    const query = { schemaVersion: 1 as const, subjectAccountId: 'me', productId: 'product/one' };
    const answer = { ...query, evaluatedAt: new Date().toISOString(), capabilities: [], quotas: [], conflicts: [] };
    request.mockResolvedValue(answer);
    await expect(oxy.billing.productAccess(query)).resolves.toEqual(answer);
    expect(request).toHaveBeenLastCalledWith('GET', '/v1/products/product%2Fone/access/me', undefined, { cache: false });
    request.mockResolvedValue({ ...answer, balance: 10 });
    await expect(oxy.billing.productAccess(query)).rejects.toThrow();
  });

  it('rejects invalid rights queries before transport and propagates authority failures', async () => {
    const { oxy, request } = stubbedClient('me');
    await expect(oxy.billing.productAccess({ schemaVersion: 1, subjectAccountId: 'me', productId: '' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockRejectedValue(new Error('Forbidden'));
    await expect(oxy.billing.productAccess({ schemaVersion: 1, subjectAccountId: 'me', productId: 'product' })).rejects.toThrow('Forbidden');
  });
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
