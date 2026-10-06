import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessGrants, accessProviderRefunds } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { revokeProductProviderPaidPeriod } from '../productProviderEvidence.service';

beforeAll(connectPostgres); afterAll(closePostgres);

async function fixture() {
  const f = await productAccessFixture();
  const input = { binding: f.providerBinding, accountId: f.payer, subscriptionId: `sub_${randomUUID()}`,
    invoiceId: `in_${randomUUID()}`, lineId: `il_${randomUUID()}`, priceId: 'price_fixture',
    paymentIntentId: `pi_${randomUUID()}`, chargeId: `ch_${randomUUID()}`, period: f.period, observedAt: f.now };
  return { f, input };
}

describe('refund fence rebuilt from typed columns', () => {
  it('fences before activation, stores no JSON copy and replays an identical observation', async () => {
    const { f, input } = await fixture();
    expect(await revokeProductProviderPaidPeriod(input)).toEqual({ status: 'fenced', revoked: 0 });
    const rows = await getDb().select().from(accessProviderRefunds).where(eq(accessProviderRefunds.payerAccountId, f.payer));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(['payload']));
    expect(rows[0]).toMatchObject({ chargeId: input.chargeId, priceId: input.priceId, providerSubscriptionId: input.subscriptionId,
      beneficiaryAccountId: f.payer, periodStart: new Date(f.period.start), periodEnd: new Date(f.period.end) });
    expect(await revokeProductProviderPaidPeriod(input)).toEqual({ status: 'replayed', revoked: 0 });
    // The same instants in another ISO spelling are the same observation.
    const respelled = { start: f.period.start.replace('Z', '000Z'), end: f.period.end.replace('Z', '000Z') };
    expect(await revokeProductProviderPaidPeriod({ ...input, period: respelled })).toEqual({ status: 'replayed', revoked: 0 });
    expect(await getDb().select().from(accessGrants).where(eq(accessGrants.beneficiaryAccountId, f.payer))).toHaveLength(0);
  });

  it.each([
    ['charge', { chargeId: 'ch_other' }],
    ['payment intent', { paymentIntentId: 'pi_other' }],
    ['price', { priceId: 'price_other' }],
  ])('refuses an incompatible %s replay for the same invoice line', async (_label, change) => {
    const { input } = await fixture();
    await revokeProductProviderPaidPeriod(input);
    await expect(revokeProductProviderPaidPeriod({ ...input, ...change })).rejects.toThrow('Immutable provider evidence identity or payload differs');
  });

  it('refuses a replay with another period or subscription for the same invoice line', async () => {
    const { f, input } = await fixture();
    await revokeProductProviderPaidPeriod(input);
    const shifted = { start: f.period.start, end: new Date(Date.parse(f.period.end) + 1000).toISOString() };
    await expect(revokeProductProviderPaidPeriod({ ...input, period: shifted })).rejects.toThrow('Immutable provider evidence identity or payload differs');
    await expect(revokeProductProviderPaidPeriod({ ...input, subscriptionId: `sub_${randomUUID()}` })).rejects.toThrow('Refund fence unavailable');
  });

  it('keeps fence rows immutable and refuses a payer/beneficiary split at the database', async () => {
    const { f, input } = await fixture();
    await revokeProductProviderPaidPeriod(input);
    const [fence] = await getDb().select().from(accessProviderRefunds).where(eq(accessProviderRefunds.payerAccountId, f.payer));
    await expect(getDb().update(accessProviderRefunds).set({ chargeId: 'forged' }).where(eq(accessProviderRefunds.id, fence.id))).rejects.toThrow();
    await expect(getDb().delete(accessProviderRefunds).where(eq(accessProviderRefunds.id, fence.id))).rejects.toThrow();
    await expect(getDb().insert(accessProviderRefunds).values({ ...fence, id: `access_refund_${randomUUID()}`, segmentId: `seg_${randomUUID()}`,
      lineId: `il_${randomUUID()}`, beneficiaryAccountId: f.beneficiary })).rejects.toThrow();
  });
});
