import {
  purchaseEffectsSchema,
  safetyRequesterSchema,
  contentAccessInputSchema,
  messageAccessInputSchema,
} from '../safety';

const effects = () => ({
  operationId: 'operation',
  resourceId: 'checkout',
  cartFingerprint: 'a'.repeat(64),
  paymentFingerprint: 'b'.repeat(64),
  summary: 'Selected items',
  merchantAccountIds: ['merchant'],
  lineItems: [
    {
      itemReference: 'item',
      title: 'Blue shirt',
      optionsText: 'Blue / L',
      merchantAccountId: 'merchant',
      quantity: 3,
      unitAmountMinor: 333,
      lineAmountMinor: 1000,
    },
  ],
  shippingMinor: 100,
  taxMinor: 100,
  discountMinor: 50,
  roundingAdjustmentMinor: -1,
  amountMinor: 1149,
  currency: 'EUR',
  expiresAt: '2026-10-15T20:00:00.000Z',
});
describe('supervised safety contracts', () => {
  it('preserves authoritative line amounts and explicit FX rounding without rewriting unit prices', () => {
    expect(purchaseEffectsSchema.parse(effects()).lineItems[0]).toMatchObject({
      quantity: 3,
      unitAmountMinor: 333,
      lineAmountMinor: 1000,
    });
  });
  it('rejects inexact totals, unsafe integer overflow and excessive rounding', () => {
    expect(purchaseEffectsSchema.safeParse({ ...effects(), amountMinor: 1150 }).success).toBe(
      false,
    );
    expect(
      purchaseEffectsSchema.safeParse({ ...effects(), amountMinor: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false);
    expect(
      purchaseEffectsSchema.safeParse({
        ...effects(),
        roundingAdjustmentMinor: 20,
        amountMinor: 1170,
      }).success,
    ).toBe(false);
    const line = { ...effects().lineItems[0], lineAmountMinor: Number.MAX_SAFE_INTEGER };
    expect(
      purchaseEffectsSchema.safeParse({
        ...effects(),
        lineItems: [line, { ...line, itemReference: 'other' }],
        amountMinor: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(false);
  });
  it('requires every merchant and unique item reference without truncating large orders', () => {
    expect(
      purchaseEffectsSchema.safeParse({ ...effects(), merchantAccountIds: ['merchant', 'missing'] })
        .success,
    ).toBe(false);
    expect(
      purchaseEffectsSchema.safeParse({
        ...effects(),
        lineItems: [...effects().lineItems, ...effects().lineItems],
      }).success,
    ).toBe(false);
    expect(
      purchaseEffectsSchema.safeParse({
        ...effects(),
        lineItems: Array.from({ length: 201 }, (_, i) => ({
          ...effects().lineItems[0],
          itemReference: `item${i}`,
        })),
      }).success,
    ).toBe(false);
  });
  it('accepts many independently rounded merchant orders within the bounded conversion stages', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `merchant${i}`);
    const input = {
      ...effects(),
      merchantAccountIds: ids,
      lineItems: ids.map((id) => ({ ...effects().lineItems[0], merchantAccountId: id })),
      roundingAdjustmentMinor: 20,
      amountMinor: 10170,
    };
    expect(purchaseEffectsSchema.safeParse(input).success).toBe(true);
  });
  it('requires an original proof and never accepts caller-selected viewer identities', () => {
    expect(safetyRequesterSchema.safeParse({ accessToken: null }).success).toBe(true);
    expect(safetyRequesterSchema.safeParse({ connectionToken: 'verified-centrally' }).success).toBe(
      true,
    );
    expect(safetyRequesterSchema.safeParse({ viewerId: 'child' }).success).toBe(false);
    expect(safetyRequesterSchema.safeParse({ accessToken: null, viewerId: 'child' }).success).toBe(
      false,
    );
  });
  it('requires authoritative author for nonpublic content and own management', () => {
    expect(
      contentAccessInputSchema.safeParse({
        resourceId: 'post',
        classification: 'unrated',
        operation: 'manage_own',
      }).success,
    ).toBe(false);
    expect(
      contentAccessInputSchema.safeParse({
        resourceId: 'post',
        classification: 'general',
        audience: 'private',
        authorAccountId: 'author',
      }).success,
    ).toBe(false);
  });
  it('keeps complete participant groups bounded and distinct', () => {
    expect(
      messageAccessInputSchema.safeParse({
        resourceId: 'chat',
        participantAccountIds: Array.from({ length: 256 }, (_, i) => `person${i}`),
      }).success,
    ).toBe(true);
    expect(
      messageAccessInputSchema.safeParse({
        resourceId: 'chat',
        participantAccountIds: ['same', 'same'],
      }).success,
    ).toBe(false);
  });
});
