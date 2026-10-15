import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  users,
  applications,
  files,
  supervisionPurchaseApprovals,
  supervisionPurchaseLines,
} from '../../db/schema';
import * as safety from '../supervision.service';

beforeAll(connectPostgres);
afterAll(closePostgres);
async function person(isStaff = false) {
  const [row] = await getDb()
    .insert(users)
    .values({ kind: 'personal', isStaff })
    .returning({ id: users.id });
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function fixture() {
  const child = await person(),
    guardian = await person(),
    staff = await person(true),
    merchant = await person();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: 'Safety merchant', ownerAccountId: merchant })
    .returning({ id: applications.id });
  if (!app) throw new Error('Missing application fixture');
  const invite = await safety.inviteGuardian(child, guardian);
  await safety.acceptInvitation(invite.id, guardian);
  const effects = {
    operationId: randomUUID(),
    resourceId: randomUUID(),
    cartFingerprint: 'a'.repeat(64),
    summary: 'Two items from the selected merchants',
    shippingMinor: 0,
    taxMinor: 0,
    discountMinor: 0,
    roundingAdjustmentMinor: 0,
    lineItems: [
      {
        itemReference: 'line1',
        title: 'Selected item',
        optionsText: 'Blue / large',
        merchantAccountId: merchant,
        quantity: 1,
        unitAmountMinor: 1999,
        lineAmountMinor: 1999,
      },
    ],
    merchantAccountIds: [merchant],
    paymentFingerprint: 'b'.repeat(64),
    amountMinor: 1999,
    currency: 'EUR',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const approval = await safety.requestPurchase(app.id, child, effects);
  return { child, guardian, staff, app: app.id, effects, approval };
}
describe('bound supervised purchase effects', () => {
  it('serializes duplicate requests and reservations and never recycles a cancelled approval', async () => {
    const f = await fixture();
    const duplicate = await Promise.all(
      Array.from({ length: 8 }, () => safety.requestPurchase(f.app, f.child, f.effects)),
    );
    expect(new Set(duplicate.map((x) => x.id))).toEqual(new Set([f.approval.id]));
    await safety.reviewPurchase(f.approval.id, f.guardian, 'approved');
    const reservation = { approvalId: f.approval.id, ...f.effects };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => safety.reservePurchase(f.app, reservation)),
    );
    expect(results.every((x) => x.status === 'reserved')).toBe(true);
    await expect(
      safety.reservePurchase(f.app, { ...reservation, amountMinor: 2000, shippingMinor: 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await safety.finishPurchase(
      f.app,
      { approvalId: f.approval.id, operationId: f.effects.operationId },
      false,
    );
    await expect(safety.reservePurchase(f.app, reservation)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('binds exact consumer and receipt across confirmed-operation retries', async () => {
    const f = await fixture();
    await safety.reviewPurchase(f.approval.id, f.guardian, 'approved');
    const input = { approvalId: f.approval.id, ...f.effects };
    await expect(safety.reservePurchase('different-app', input)).rejects.toMatchObject({
      code: 'not_found',
    });
    await safety.reservePurchase(f.app, input);
    const receipt = {
      approvalId: f.approval.id,
      operationId: f.effects.operationId,
      receiptReference: 'merchant-ledger/order',
    };
    expect((await safety.finishPurchase(f.app, receipt, true)).status).toBe('confirmed');
    expect((await safety.finishPurchase(f.app, receipt, true)).status).toBe('confirmed');
    await expect(
      safety.finishPurchase(f.app, { ...receipt, receiptReference: 'other-order' }, true),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      getDb()
        .update(supervisionPurchaseApprovals)
        .set({ amountMinor: 1 })
        .where(eq(supervisionPurchaseApprovals.id, f.approval.id)),
    ).rejects.toThrow();
  });
  it('serializes concurrent policy end and reservation without deadlock or a stale new approval', async () => {
    const f = await fixture();
    await safety.reviewPurchase(f.approval.id, f.guardian, 'approved');
    const results = await Promise.allSettled([
      safety.reviewSupervision(f.staff, {
        childAccountId: f.child,
        action: 'end',
        evidenceReference: 'reviewed-case',
        reauth: { password: 'verified-at-route' },
      }),
      safety.reservePurchase(f.app, { approvalId: f.approval.id, ...f.effects }),
    ]);
    if (results[0].status === 'rejected') throw results[0].reason;
    expect(results[0].status).toBe('fulfilled');
    if (results[1].status === 'rejected')
      expect(results[1].reason).toMatchObject({ code: 'conflict' });
    const [row] = await getDb()
      .select()
      .from(supervisionPurchaseApprovals)
      .where(eq(supervisionPurchaseApprovals.id, f.approval.id));
    expect(['reserved', 'cancelled']).toContain(row.status);
  });
  it('prevents direct generic privacy and file visibility writes from weakening protection', async () => {
    const f = await fixture();
    await expect(
      getDb().update(users).set({ privacyIsPrivateAccount: false }).where(eq(users.id, f.child)),
    ).rejects.toThrow();
    const file = {
      ownerUserId: f.child,
      sha256: randomUUID(),
      size: 1,
      mime: 'image/png',
      ext: 'png',
      storageKey: 'private/test',
    };
    await expect(
      getDb()
        .insert(files)
        .values({ ...file, visibility: 'public' }),
    ).rejects.toThrow();
    const [stored] = await getDb().insert(files).values(file).returning({ id: files.id });
    await expect(
      getDb().update(files).set({ visibility: 'public' }).where(eq(files.id, stored.id)),
    ).rejects.toThrow();
  });
  it('returns complete immutable evidence only to the child or current guardian and erases its normalized lines', async () => {
    const f = await fixture();
    expect((await safety.getPurchase(f.approval.id, f.guardian)).lineItems).toEqual(
      f.effects.lineItems,
    );
    expect((await safety.getPurchase(f.approval.id, f.child)).lineItems).toEqual(
      f.effects.lineItems,
    );
    await expect(safety.getPurchase(f.approval.id, f.staff)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      getDb()
        .update(supervisionPurchaseLines)
        .set({ title: 'Replaced item' })
        .where(eq(supervisionPurchaseLines.approvalId, f.approval.id)),
    ).rejects.toThrow();
    await expect(
      getDb()
        .delete(supervisionPurchaseLines)
        .where(eq(supervisionPurchaseLines.approvalId, f.approval.id)),
    ).rejects.toThrow();
    await getDb().delete(users).where(eq(users.id, f.child));
    expect(
      await getDb()
        .select()
        .from(supervisionPurchaseLines)
        .where(eq(supervisionPurchaseLines.approvalId, f.approval.id)),
    ).toEqual([]);
  });
});
