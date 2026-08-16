/**
 * The request shapes for `/billing/accounts` and `/billing/cost-centers`.
 *
 * The case worth the file is `includeRetired`. Query strings arrive as strings
 * and `z.coerce.boolean()` is `Boolean(value)`, so the literal `'false'` coerces
 * to TRUE — a client asking to HIDE retired cost centres would be handed them,
 * and only omitting the parameter entirely would ever mean false. It is the
 * quietest possible defect: the flag is honoured in exactly the case nobody
 * tests (absent) and inverted in the case every client sends.
 *
 * The rest assert that a body which would move money in an unintended way is
 * refused at the boundary rather than stripped, because a stripped field still
 * existed upstream of the parse.
 */

import {
  costCenterListQuery,
  promotionalGrantBody,
  topUpCheckoutBody,
  updateBillingProfileBody,
} from '../accountBilling.schemas';

describe('costCenterListQuery', () => {
  it('reads an explicit false as false', () => {
    expect(costCenterListQuery.parse({ includeRetired: 'false' })).toEqual({
      includeRetired: false,
    });
  });

  it('reads an explicit true as true', () => {
    expect(costCenterListQuery.parse({ includeRetired: 'true' })).toEqual({
      includeRetired: true,
    });
  });

  it('defaults to false when the parameter is absent', () => {
    expect(costCenterListQuery.parse({})).toEqual({ includeRetired: false });
  });

  it('refuses a value it cannot read, rather than guessing', () => {
    // `z.coerce.boolean()` would have made every one of these `true`.
    for (const value of ['no', '0', 'FALSE', '']) {
      expect(costCenterListQuery.safeParse({ includeRetired: value }).success).toBe(false);
    }
  });
});

describe('the money-moving bodies are strict', () => {
  it('refuses a top-up amount expressed as a JSON number', () => {
    expect(
      topUpCheckoutBody.safeParse({
        amount: 20,
        successUrl: 'https://console.oxy.so/ok',
        cancelUrl: 'https://console.oxy.so/no',
      }).success
    ).toBe(false);
  });

  it('accepts an exact decimal top-up', () => {
    expect(
      topUpCheckoutBody.safeParse({
        amount: '20.000000000000',
        successUrl: 'https://console.oxy.so/ok',
        cancelUrl: 'https://console.oxy.so/no',
      }).success
    ).toBe(true);
  });

  it('refuses an unknown key beside a credit limit', () => {
    // `.strict()`, not `.passthrough()`: the keys somebody would smuggle in here
    // are the two that decide whether an account may spend money it does not
    // have, and a stripped field survives in whatever proxied the request.
    expect(
      updateBillingProfileBody.safeParse({ creditLimit: '100', creditLimitOverride: '999' })
        .success
    ).toBe(false);
  });

  it('requires a caller-supplied idempotency key on a grant', () => {
    // A grant is money. A server-generated key would make a double-submitted
    // form two grants.
    expect(promotionalGrantBody.safeParse({ amount: '10.000000000000' }).success).toBe(false);
    expect(
      promotionalGrantBody.safeParse({
        amount: '10.000000000000',
        idempotencyKey: 'campaign-2026-08',
      }).success
    ).toBe(true);
  });

});
