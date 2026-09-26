import type { ReputationBalance, ReputationBalanceSummary } from '@oxy.so/contracts';
import { OxyAuthenticationError } from '../../OxyServices.errors';
import { stubbedClient } from './helpers';

const full: ReputationBalance = {
  userId: 'u1',
  total: 120,
  positive: 150,
  negative: -30,
  breakdown: { content: 80, social: 40, trust: 0, moderation: 0, physical: 0, penalties: 30 },
  trustTier: 'trusted',
  influence: { defaultWeight: 1, reportWeight: 1, moderationWeight: 1, rankingFeedbackWeight: 0.8 },
  reliability: { accurateReports: 2, rejectedReports: 0, reportAccuracyScore: 1, abuseScore: 0 },
  recalculatedAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
};
const summary: ReputationBalanceSummary = { userId: 'u1', total: 120, trustTier: 'trusted' };

describe('oxy.reputation', () => {
  describe('balance', () => {
    it('reads any user by id, URL-encoded, passing the public view through', async () => {
      const { oxy, request } = stubbedClient('me');
      request.mockResolvedValue(summary);
      await expect(oxy.reputation.balance('a/b')).resolves.toBe(summary);
      expect(request).toHaveBeenCalledWith('GET', '/reputation/a%2Fb/balance', undefined, { cache: true, cacheTTL: 120000 });
    });

    it('with no id reads the signed-in user, in full', async () => {
      const { oxy, request } = stubbedClient('u1');
      request.mockResolvedValue(full);
      await expect(oxy.reputation.balance()).resolves.toBe(full);
      expect(request).toHaveBeenCalledWith('GET', '/reputation/u1/balance', undefined, expect.anything());
    });

    it('with no id throws when signed out, without a request', async () => {
      const { oxy, request } = stubbedClient();
      await expect(oxy.reputation.balance()).rejects.toBeInstanceOf(OxyAuthenticationError);
      expect(request).not.toHaveBeenCalled();
    });

    it('with no id throws when the server answered the public view', async () => {
      const { oxy, request } = stubbedClient('u1');
      request.mockResolvedValue(summary);
      await expect(oxy.reputation.balance()).rejects.toBeInstanceOf(OxyAuthenticationError);
    });
  });

  it('unwraps the leaderboard page and omits empty params', async () => {
    const { oxy, request } = stubbedClient();
    request.mockResolvedValue({ data: [{ userId: 'u1' }] });
    await expect(oxy.reputation.leaderboard()).resolves.toEqual([{ userId: 'u1' }]);
    expect(request).toHaveBeenLastCalledWith('GET', '/reputation/leaderboard', undefined, { cache: true, cacheTTL: 300000 });
    await oxy.reputation.leaderboard({ limit: 5, offset: 0 });
    expect(request).toHaveBeenLastCalledWith('GET', '/reputation/leaderboard', { limit: 5, offset: 0 }, expect.anything());
    request.mockResolvedValue({});
    await expect(oxy.reputation.leaderboard()).resolves.toEqual([]);
  });

  it('unwraps the rules with a long cache', async () => {
    const { oxy, request } = stubbedClient();
    request.mockResolvedValue({ rules: [{ id: 'r1' }] });
    await expect(oxy.reputation.rules()).resolves.toEqual([{ id: 'r1' }]);
    expect(request).toHaveBeenCalledWith('GET', '/reputation/rules', undefined, { cache: true, cacheTTL: 1800000 });
    request.mockResolvedValue({});
    await expect(oxy.reputation.rules()).resolves.toEqual([]);
  });

  it('reads the ledger, defaulting to the signed-in user', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({ data: [{ id: 't1' }] });
    await expect(oxy.reputation.transactions()).resolves.toEqual([{ id: 't1' }]);
    expect(request).toHaveBeenLastCalledWith('GET', '/reputation/me/transactions', undefined, { cache: true, cacheTTL: 60000 });
    await oxy.reputation.transactions('u2', { limit: 10 });
    expect(request).toHaveBeenLastCalledWith('GET', '/reputation/u2/transactions', { limit: 10 }, expect.anything());
  });

  it('passes the influence context only when given', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({ weight: 1 });
    await oxy.reputation.influence('u2', 'report');
    expect(request).toHaveBeenLastCalledWith('GET', '/reputation/u2/influence', { context: 'report' }, { cache: true, cacheTTL: 120000 });
    await oxy.reputation.influence();
    expect(request).toHaveBeenLastCalledWith('GET', '/reputation/me/influence', undefined, expect.anything());
  });

  it('exposes no way to edit anyone\'s standing', () => {
    const { oxy } = stubbedClient();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(oxy.reputation));
    for (const forbidden of ['award', 'upsertRule', 'reverse', 'void', 'recalculate', 'createDispute', 'resolveDispute']) {
      expect(methods).not.toContain(forbidden);
    }
  });
});
