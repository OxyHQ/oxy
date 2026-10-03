import { composeSubjectProductAccess } from '../productAccess';
import { subjectProductAccessSchema, productOfferSchema, productSubscriptionSourceSchema, productOfferSegmentSchema, productAccessGrantSchema, type ProductAccessGrant, type ProductOfferSegment, type ProductSubscriptionSource } from '@oxy.so/contracts';

const subject = 'subject';
const period = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };
const now = new Date('2026-10-02T00:00:00.000Z');
function source(id: string, overrides: Record<string, unknown> = {}): ProductSubscriptionSource {
  return productSubscriptionSourceSchema.parse({ schemaVersion: 1, id, beneficiaryAccountId: subject, payerAccountId: 'payer', provider: 'stripe', providerSubscriptionId: `sub_${id}`, status: 'active', period, cancelAtPeriodEnd: false, ...overrides });
}
function segment(id: string, overrides: Record<string, unknown> = {}): ProductOfferSegment {
  return productOfferSegmentSchema.parse({ schemaVersion: 1, id, subscriptionId: id, beneficiaryAccountId: subject, offerId: id, offerVersion: 1, origin: 'individual', period, ...overrides });
}
function grant(id: string, sourceId: string, overrides: Record<string, unknown> = {}): ProductAccessGrant {
  return productAccessGrantSchema.parse({ schemaVersion: 1, id, sourceSegmentId: sourceId, beneficiaryAccountId: subject, offerId: sourceId, offerVersion: 1, origin: 'individual', benefit: { kind: 'capability', productId: 'alia', key: 'chat' }, period, revokedAt: null, ...overrides });
}
function read(sources: ProductSubscriptionSource[], segments: ProductOfferSegment[], grants: ProductAccessGrant[], productId = 'alia') {
  return composeSubjectProductAccess({ subjectAccountId: subject, productId, now, sources, segments, grants });
}

describe('subject/product access composition (no financial disclosure)', () => {
  it('keeps two products independent and supports a different payer', () => {
    const sources = [source('one'), source('two')];
    const segments = [segment('one'), segment('two')];
    const grants = [grant('a', 'one'), grant('b', 'two', { benefit: { kind: 'capability', productId: 'mention', key: 'premium' } })];
    expect(read(sources, segments, grants).capabilities).toEqual([{ key: 'chat', grantIds: ['a'] }]);
    expect(read(sources, segments, grants, 'mention').capabilities).toEqual([{ key: 'premium', grantIds: ['b'] }]);
    expect(JSON.stringify(read(sources, segments, grants))).not.toMatch(/payer|stripe|sub_one|price|balance/);
  });
  it('cancels one individual source while retaining an overlapping bundle', () => {
    const sources = [source('one', { status: 'canceled' }), source('bundle')];
    const segments = [segment('one'), segment('bundle', { origin: 'bundle' })];
    const grants = [grant('a', 'one'), grant('b', 'bundle', { origin: 'bundle' })];
    expect(read(sources, segments, grants).capabilities).toEqual([{ key: 'chat', grantIds: ['b'] }]);
  });
  it('scheduled cancellation keeps access until the paid period expires', () => {
    const sources = [source('one', { cancelAtPeriodEnd: true })];
    expect(read(sources, [segment('one')], [grant('a', 'one')]).capabilities).toHaveLength(1);
    expect(composeSubjectProductAccess({ subjectAccountId: subject, productId: 'alia', now: new Date(period.end), sources, segments: [segment('one')], grants: [grant('a', 'one')] }).capabilities).toEqual([]);
  });
  it('retains old immutable segments when an upgrade appends a new offer version', () => {
    const sources = [source('one')];
    const segments = [segment('old', { subscriptionId: 'one' }), segment('new', { subscriptionId: 'one', offerVersion: 2 })];
    const grants = [grant('a', 'old'), grant('b', 'new', { offerVersion: 2, benefit: { kind: 'capability', productId: 'alia', key: 'upgrade' } })];
    expect(read(sources, segments, grants).capabilities.map(row => row.key)).toEqual(['chat', 'upgrade']);
  });
  it('excludes other beneficiaries, revoked grants and suspended sources without a cache', () => {
    const sources = [source('one'), source('other', { beneficiaryAccountId: 'other' }), source('paused', { status: 'paused' })];
    const segments = [segment('one'), segment('other', { beneficiaryAccountId: 'other' }), segment('paused')];
    const grants = [grant('a', 'one', { revokedAt: now.toISOString() }), grant('b', 'other', { beneficiaryAccountId: 'other' }), grant('c', 'paused')];
    expect(read(sources, segments, grants).capabilities).toEqual([]);
    grants[0].revokedAt = null;
    expect(read(sources, segments, grants).capabilities).toHaveLength(1);
  });
  it.each(['maximum', 'sum', 'exclusive'] as const)('applies only explicitly declared quota combination %s', combination => {
    const sources = [source('one'), source('two')];
    const segments = [segment('one'), segment('two')];
    const grants = [grant('a', 'one', { benefit: { kind: 'quota', productId: 'alia', key: 'messages', unit: 'messages', included: 10, combination } }), grant('b', 'two', { benefit: { kind: 'quota', productId: 'alia', key: 'messages', unit: 'messages', included: 20, combination } })];
    const result = read(sources, segments, grants);
    if (combination === 'exclusive') expect(result.conflicts[0].reason).toBe('exclusive_overlap');
    else expect(result.quotas[0].included).toBe(combination === 'sum' ? 30 : 20);
  });
  it('reports mismatched quota rules with no quota granted', () => {
    const sources = [source('one'), source('two')];
    const grants = [grant('a', 'one', { benefit: { kind: 'quota', productId: 'alia', key: 'messages', unit: 'messages', included: 10, combination: 'sum' } }), grant('b', 'two', { benefit: { kind: 'quota', productId: 'alia', key: 'messages', unit: 'messages', included: 20, combination: 'maximum' } })];
    const result = read(sources, [segment('one'), segment('two')], grants);
    expect(result.quotas).toEqual([]);
    expect(result.conflicts[0].reason).toBe('combination_mismatch');
  });
  it('rejects counterfeit provenance and financial fields in access responses', () => {
    expect(() => read([source('one')], [segment('one')], [grant('a', 'one', { offerVersion: 2 })])).toThrow('provenance');
    expect(subjectProductAccessSchema.safeParse({ ...read([], [], []), balance: 500 }).success).toBe(false);
  });
});

it('individual offers cannot silently grant multiple products', () => {
  expect(productOfferSchema.safeParse({ schemaVersion: 1, id: 'individual', version: 1, kind: 'individual', benefits: [{ kind: 'capability', productId: 'alia', key: 'chat' }, { kind: 'capability', productId: 'mention', key: 'premium' }] }).success).toBe(false);
});
