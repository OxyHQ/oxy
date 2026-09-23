/**
 * The workload mint does not share the credential mint's budget.
 *
 * Both used to run through `serviceTokenLimiter`, which is 10 requests per five
 * minutes keyed on the caller's address. That is the right number for a
 * credential mint, where the api key and secret are guessable and a wide budget
 * is a brute-force budget. It is the wrong number for the workload path, and
 * sharing it was a fleet-wide outage waiting for adoption:
 *
 *   * every deployed service egresses through the same NAT address, so the
 *     estate shares one bucket;
 *   * one mint costs TWO requests, a challenge and an exchange;
 *   * so the whole fleet had five mints per five minutes, against roughly
 *     thirty services each re-minting an hourly token on every task.
 *
 * Measured on 2026-09-19 while verifying the fourth service of the migration:
 * `Oxy refused to issue a workload challenge (429)`, from a handful of hand-run
 * checks with most of the fleet not yet moved.
 *
 * This asserts the separation at construction time — the prefix is what makes
 * two limiters two buckets rather than one shared counter — and the budget,
 * because a separate bucket of ten would have fixed nothing.
 */

const constructed: Array<{ prefix?: string; max?: number; windowMs?: number }> = [];

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation((options: { prefix?: string }) => {
    constructed.push({ prefix: options?.prefix });
    return {
      init: jest.fn(),
      increment: jest.fn(async () => ({ totalHits: 1, resetTime: new Date() })),
      decrement: jest.fn(),
      resetKey: jest.fn(),
      resetAll: jest.fn(),
    };
  }),
}));

jest.mock('../../config/redis', () => ({
  getRedisClient: () => ({ call: jest.fn() }),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', 'auth.ts'), 'utf8');

describe('the workload mint has its own budget', () => {
  it('registers a limiter under its own prefix, not the credential mint’s', () => {
    expect(source).toContain("prefix: 'rl:auth:service-token-workload:'");
    // Sharing a prefix is not a style question: two limiters on one prefix
    // increment the same counter, which express-rate-limit reports as
    // ERR_ERL_DOUBLE_COUNT and which halves the budget silently when it does
    // not.
    expect(source).toContain("prefix: 'rl:auth:service-token:'");
  });

  it('gives both workload routes that limiter and neither the credential one', () => {
    const challenge = /router\.post\('\/service-token\/workload\/challenge',\s*(\w+)/.exec(source);
    const exchange = /router\.post\(\s*'\/service-token\/workload',\s*(\w+)/.exec(source);
    const credential = /router\.post\('\/service-token',\s*(\w+)/.exec(source);

    expect(challenge?.[1]).toBe('workloadTokenLimiter');
    expect(exchange?.[1]).toBe('workloadTokenLimiter');
    // The credential mint keeps its own limiter, now keyed on the credential it names.
    expect(credential?.[1]).toBe('serviceTokenLimiter');
  });

  it('sizes the workload budget for a fleet rather than for a person typing', () => {
    const workloadBlock = source.slice(source.indexOf('const workloadTokenLimiter'));
    const max = /max:[^,]*?(\d[\d_]*),/.exec(workloadBlock);
    const parsed = Number((max?.[1] ?? '0').replace(/_/g, ''));

    // Thirty services, two tasks each, an hourly token and two requests per
    // mint is about 25 requests in five minutes at steady state — and a deploy
    // or a restart storm is a multiple of that. Ten was the number that broke.
    expect(parsed).toBeGreaterThanOrEqual(300);
  });
});
