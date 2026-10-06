import { stubbedClient } from './helpers';

describe('oxy.billing', () => {
  it('loads public plans through the shared schema and refuses invented prices', async () => {
    const { oxy, request } = stubbedClient('me');
    const answer = { schemaVersion: 1, state: 'unconfigured', purchase: 'unavailable', plans: [] };
    request.mockResolvedValue(answer);
    await expect(oxy.billing.personalPlans()).resolves.toEqual(answer);
    expect(request).toHaveBeenLastCalledWith('GET', '/billing/personal-plans', undefined, { cache: false });
    request.mockResolvedValue({ ...answer, price: 2999 });
    await expect(oxy.billing.personalPlans()).rejects.toThrow();
  });
  it('fences a subscription read to the rendered account', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({ subscriptions: [] });
    await oxy.billing.productSubscriptions('account/one');
    expect(request).toHaveBeenLastCalledWith('GET', '/billing/product-subscriptions?expectedSubjectAccountId=account%2Fone', undefined, { cache: false });
  });
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
  it("reads plural sources and immutable grant provenance uncached, rejecting mixed units", async () => {
    const { oxy, request } = stubbedClient('me');
		request.mockResolvedValue({ subscriptions: [] });
		await expect(oxy.billing.productSubscriptions()).resolves.toEqual([]);
		expect(request).toHaveBeenLastCalledWith(
			'GET',
			"/billing/product-subscriptions",
			undefined,
			{ cache: false },
		);
		const grant = {
			id: "grant",
			invoiceId: "invoice",
			origin: "subscription_payment",
			period: {
				start: "2026-01-01T00:00:00.000Z",
				end: "2026-02-01T00:00:00.000Z",
			},
			granted: 10,
			consumed: 3,
			clawed: 2,
			remaining: 5,
			promotionId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		request.mockResolvedValue({ grants: [grant] });
		await expect(oxy.billing.creditGrants()).resolves.toEqual([grant]);
		expect(request).toHaveBeenLastCalledWith(
			'GET',
			"/billing/credit-grants",
			undefined,
			{ cache: false },
		);
		request.mockResolvedValue({ grants: [{ ...grant, remaining: 6 }] });
		await expect(oxy.billing.creditGrants()).rejects.toThrow();
		request.mockResolvedValue({ subscriptions: [], balance: 100 });
		await expect(oxy.billing.productSubscriptions()).rejects.toThrow();
	});
	it("cancels only the named source and rejects an empty selector before transport", async () => {
		const { oxy, request } = stubbedClient('me');
		await expect(oxy.billing.cancelProductSubscription("")).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
		request.mockResolvedValue({ sourceId: "source", cancelAtPeriodEnd: true });
		await oxy.billing.cancelProductSubscription("source");
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/billing/product-subscriptions/cancel",
			{ sourceId: "source" },
			{ cache: false },
		);
	});
  it('distinguishes pending reconciliation and completed cancellation without changing legacy acceptance', async () => {
    const { oxy, request } = stubbedClient('me');
    const pending = { sourceId: 'source', reconciliationPending: true };
    request.mockResolvedValue(pending);
    await expect(oxy.billing.cancelProductSubscriptionWithStatus('source')).resolves.toEqual(pending);
    await expect(oxy.billing.cancelProductSubscription('source')).resolves.toBeUndefined();
    request.mockResolvedValue({ ...pending, cancelAtPeriodEnd: true });
    await expect(oxy.billing.cancelProductSubscriptionWithStatus('source')).rejects.toThrow();
    request.mockResolvedValue({ sourceId: 'source', cancelAtPeriodEnd: true });
    await expect(oxy.billing.cancelProductSubscriptionWithStatus('source')).resolves.toEqual({ sourceId: 'source', cancelAtPeriodEnd: true });
    request.mockRejectedValue(new Error('Forbidden'));
    await expect(oxy.billing.cancelProductSubscriptionWithStatus('source')).rejects.toThrow('Forbidden');
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

it('forwards one explicit cancellation action identity without regenerating it on retry',async()=>{
 const {oxy,request}=stubbedClient('me');request.mockResolvedValue({sourceId:'source',cancelAtPeriodEnd:true});
 await oxy.billing.cancelProductSubscriptionWithStatus('source','me','action_001');await oxy.billing.cancelProductSubscriptionWithStatus('source','me','action_001');
 expect(request).toHaveBeenLastCalledWith('POST','/billing/product-subscriptions/cancel',{sourceId:'source',expectedSubjectAccountId:'me',actionId:'action_001'},{cache:false});
 await oxy.billing.cancelProductSubscriptionWithStatus('source','me','action_002');expect(request.mock.calls[2][2]).toMatchObject({actionId:'action_002'});
});
