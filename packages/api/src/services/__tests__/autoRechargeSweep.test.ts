/**
 * The auto-recharge sweep is REACHABLE, and it refuses where it cannot work.
 *
 * ## Why a registration test at all
 *
 * The claim/charge/settle machinery can be complete, fully tested and entirely
 * INERT: every unit green while nothing calls the entrypoint, so a customer
 * switches auto-recharge on, the balance still runs out, and their requests
 * start failing. That is exactly the shape `PATCH /billing/accounts/:accountId`
 * would ship if `server.ts` never registered a sweep — and the profile CHECK
 * even refuses an enabled setting with no threshold on the stated grounds that
 * it would be "a setting that reads as on and never fires".
 *
 * So the assertion is on the ENTRYPOINT: `server.ts` names `runAutoRechargeSweep`
 * and schedules it. It carries its own vacuity floor — the same read must find
 * the sweeps that were already there, or a mis-resolved path would report a
 * clean absence.
 *
 * ## And the processor guard
 *
 * With no `STRIPE_SECRET_KEY` the sweep must not touch an account: `getStripe()`
 * would throw on the first candidate, turning a routine interval into an error
 * per account per five minutes. `processor-unconfigured` is a status the caller
 * logs once.
 */

import { runAutoRechargeSweep } from '../stripeAccountBilling.service';
import { AUTO_RECHARGE_SWEEP_INTERVAL_MS } from '../../db/schema/billingAutoRechargeAttempts';

// That the entrypoint SCHEDULES this sweep is asserted with every other sweep's
// registration in `src/__tests__/scheduledSweeps.test.ts`.
describe('the sweep interval', () => {
  it('runs far more often than a card may be charged', () => {
    // The interval decides how promptly a candidate is NOTICED; the claim window
    // decides how often one may be CHARGED. Collapsing them would make the
    // safety bound a scheduling knob.
    expect(AUTO_RECHARGE_SWEEP_INTERVAL_MS).toBeLessThan(3600 * 1000);
  });
});

describe('the sweep disables itself where it cannot charge', () => {
  const original = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = original;
    }
  });

  it('reports processor-unconfigured rather than throwing per account', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(runAutoRechargeSweep()).resolves.toEqual({ status: 'processor-unconfigured' });
  });
});
