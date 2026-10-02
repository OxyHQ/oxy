import { eq, sql } from 'drizzle-orm';
import { executeRows } from '@oxy.so/db';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessSubscriptionSources, accessGrants, accountClosureFences } from '../../db/schema';
import { recordProductAccessPeriod, updateProductAccessSourceState } from '../productAccessPersistence.service';
import { archiveAccountForRetention, beginAccountClosure, describeAccountFinancialHolds } from '../accountFinancialHolds.service';
import { productAccessFixture as fixture } from '../__fixtures__/productAccessFixtures';

jest.setTimeout(60_000);
beforeAll(connectPostgres); afterAll(closePostgres);
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitForBlockedTransaction(holderPid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await executeRows<{ blocked: boolean }>(getDb(), sql`select exists (
      select 1 from pg_locks holder join pg_locks waiter on waiter.transactionid = holder.transactionid
      where holder.pid = ${holderPid} and holder.locktype = 'transactionid' and holder.granted
      and waiter.locktype = 'transactionid' and not waiter.granted and waiter.pid <> holder.pid
    ) as blocked`);
    if (rows[0]?.blocked) return;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error('Expected competing transaction to wait on the account row holder');
}
it('live source prevents closure in both roles and retains provenance', async () => {
  const f = await fixture(); const input = f.input(); await recordProductAccessPeriod(input);
  for (const id of [f.beneficiary, f.payer]) {
    const holds = await describeAccountFinancialHolds(id);
    expect(holds.hasLiveSubscription).toBe(true); expect(holds.liveSubscriptionIds).toContain(input.source.id);
    await expect(beginAccountClosure(id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await getDb().select().from(accountClosureFences).where(eq(accountClosureFences.accountId, id))).toEqual([]);
  }
});
it('terminal source retains history; closure rejects reactivation and new awards', async () => {
  const f = await fixture(); const input = f.input(); await recordProductAccessPeriod(input);
  const update = { sourceId: input.source.id, productId: f.products[0].id, providerBinding: f.providerBinding,
    period: f.period, cancelAtPeriodEnd: false, providerObservedAt: new Date(f.now.getTime() + 1000) };
  await updateProductAccessSourceState({ ...update, status: 'canceled' });
  const holds = await describeAccountFinancialHolds(f.beneficiary);
  expect(holds.hasLiveSubscription).toBe(false); expect(holds.retainedRecords.length).toBeGreaterThan(0);
  await archiveAccountForRetention(f.beneficiary);
  await expect(updateProductAccessSourceState({ ...update, status: 'active', providerObservedAt: new Date(f.now.getTime() + 2000) })).rejects.toMatchObject({ statusCode: 409 });
  const next = f.input(); await expect(recordProductAccessPeriod(next)).rejects.toMatchObject({ statusCode: 409 });
  expect(await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, next.source.id))).toEqual([]);
  expect(await getDb().select().from(accessGrants).where(eq(accessGrants.sourceSegmentId, input.segment.id))).toHaveLength(2);
});
it('closure first: award waits on the real row lock and fails without writes', async () => {
  const f = await fixture(); const input = f.input(); const entered = latch(); const release = latch(); let pid = 0;
  const closing = archiveAccountForRetention(f.beneficiary, { withinTransaction: async tx => {
    pid = (await executeRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`))[0].pid;
    entered.resolve(); await release.promise;
  } });
  await entered.promise;
  const award = recordProductAccessPeriod(input).then(value => ({ value }), error => ({ error }));
  try { await waitForBlockedTransaction(pid); } finally { release.resolve(); }
  await closing; expect(await award).toMatchObject({ error: { statusCode: 409 } });
  expect(await getDb().select().from(accessSubscriptionSources).where(eq(accessSubscriptionSources.id, input.source.id))).toEqual([]);
});
it('award first: closure waits on the real row lock and rejects the committed live source', async () => {
  const f = await fixture(); const input = f.input(); const entered = latch(); const release = latch(); let pid = 0;
  const award = getDb().transaction(async tx => {
    await recordProductAccessPeriod(input, tx);
    pid = (await executeRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`))[0].pid;
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  const closing = beginAccountClosure(f.beneficiary).then(value => ({ value }), error => ({ error }));
  try { await waitForBlockedTransaction(pid); } finally { release.resolve(); }
  await award; expect(await closing).toMatchObject({ error: { statusCode: 409 } });
  expect(await getDb().select().from(accountClosureFences).where(eq(accountClosureFences.accountId, f.beneficiary))).toEqual([]);
});
