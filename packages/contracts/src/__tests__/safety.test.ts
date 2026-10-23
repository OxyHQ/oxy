import {
  safetyOrganizationsInputSchema,
  safetyOrganizationsResponseSchema,
  messagingSessionsInputSchema,
  messagingSessionsResponseSchema,
  purchaseEffectsSchema,
  safetyRequesterSchema,
  contentAccessInputSchema,
  messageAccessInputSchema,
  messageAccessBatchInputSchema,
  deliveryAccessBatchInputSchema,
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
    expect(safetyRequesterSchema.safeParse({ capabilityTicket: 'signed-operation' }).success).toBe(
      true,
    );
    expect(
      safetyRequesterSchema.safeParse({ capabilityTicket: 'signed-operation', accessToken: null })
        .success,
    ).toBe(false);
    expect(safetyRequesterSchema.safeParse({ requesterContext: 'verified-context' }).success).toBe(
      true,
    );
    expect(
      safetyRequesterSchema.safeParse({
        requesterContext: 'verified-context',
        capabilityTicket: 'other-proof',
      }).success,
    ).toBe(false);
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
  it('bounds total message work without splitting a conversation or rejecting self-management', () => {
    const item = { resourceId: 'self', participantAccountIds: ['owner'] };
    expect(messageAccessBatchInputSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(messageAccessBatchInputSchema.safeParse({ items: [item, item] }).success).toBe(false);
    expect(
      messageAccessBatchInputSchema.safeParse({
        items: Array.from({ length: 101 }, (_, i) => ({ ...item, resourceId: String(i) })),
      }).success,
    ).toBe(false);
    const large = Array.from({ length: 1024 }, (_, i) => String(i));
    const items = Array.from({ length: 4 }, (_, i) => ({
      resourceId: String(i),
      participantAccountIds: large,
    }));
    expect(messageAccessBatchInputSchema.safeParse({ items }).success).toBe(true);
    expect(messageAccessBatchInputSchema.safeParse({ items: [...items, item] }).success).toBe(
      false,
    );
    expect(deliveryAccessBatchInputSchema.safeParse({ items: [item] }).success).toBe(false);
    const long = large.map((id) => '界'.repeat(100) + id);
    expect(
      messageAccessBatchInputSchema.safeParse({
        items: items.map((entry) => ({ ...entry, participantAccountIds: long })),
      }).success,
    ).toBe(false);
  });
  it('bounds socket proofs and never exposes denied identity or token fields', () => {
    const item = { requestId: 'socket', accessToken: 'original' };
    expect(messagingSessionsInputSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(messagingSessionsInputSchema.safeParse({ items: [item, item] }).success).toBe(false);
    expect(
      messagingSessionsInputSchema.safeParse({
        items: Array.from({ length: 100 }, (_, i) => ({
          requestId: String(i),
          accessToken: 'a'.repeat(16384),
        })),
      }).success,
    ).toBe(false);
    expect(
      messagingSessionsResponseSchema.safeParse({
        items: [{ requestId: 'socket', allowed: false, accountId: 'leak' }],
      }).success,
    ).toBe(false);
    expect(
      messagingSessionsResponseSchema.safeParse({
        items: [{ requestId: 'socket', allowed: true, accountId: 'person', accessToken: 'leak' }],
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

it('bounds minimal employer selection and rejects extra directory content or identity assignment', () => {
  expect(
    safetyOrganizationsInputSchema.safeParse({
      ids: Array.from({ length: 101 }, (_, i) => String(i)),
    }).success,
  ).toBe(false);
  expect(safetyOrganizationsInputSchema.safeParse({ query: 'Acme', limit: 21 }).success).toBe(
    false,
  );
  expect(safetyOrganizationsInputSchema.safeParse({ query: 'Acme', actor: 'other' }).success).toBe(
    false,
  );
  const organization = {
    accountId: 'org',
    username: 'org',
    name: 'Acme',
    organizationType: 'business',
  };
  const response = { items: [{ requestedAccountId: 'old', organization }], missingIds: [] };
  expect(safetyOrganizationsResponseSchema.parse(response)).toEqual(response);
  for (const key of ['avatar', 'websiteUrl', 'legalName', 'aliases', 'domains'])
    expect(
      safetyOrganizationsResponseSchema.safeParse({
        ...response,
        items: [{ requestedAccountId: 'old', organization: { ...organization, [key]: 'unrated' } }],
      }).success,
    ).toBe(false);
});
