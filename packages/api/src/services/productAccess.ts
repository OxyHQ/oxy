/**
 * I07 composition mechanics. This module is not a purchase or permission gate.
 * Callers must authorize the subject using live authority before disclosing an
 * answer. There are no built-in offers, inherited subjects, quotas or caches.
 */
import {
  productAccessGrantSchema,
  productSubscriptionSourceSchema,
  productOfferSegmentSchema,
  subjectProductAccessSchema,
  subjectProductAccessQuerySchema,
  type ProductAccessGrant,
  type ProductSubscriptionSource,
  type ProductOfferSegment,
  type SubjectProductAccess,
} from '@oxy.so/contracts';

export function composeSubjectProductAccess(input: {
  subjectAccountId: string;
  productId: string;
  now: Date;
  sources: ProductSubscriptionSource[];
  segments: ProductOfferSegment[];
  grants: ProductAccessGrant[];
}): SubjectProductAccess {
  const query = subjectProductAccessQuerySchema.parse({
    schemaVersion: 1,
    subjectAccountId: input.subjectAccountId,
    productId: input.productId,
  });
  const now = input.now.getTime();
  const sources = new Map(
    input.sources.map((source) => {
      const parsed = productSubscriptionSourceSchema.parse(source);
      return [parsed.id, parsed] as const;
    }),
  );
  if (sources.size !== input.sources.length)
    throw new Error('duplicate source subscription identity');
  const segments = new Map(
    input.segments.map((segment) => {
      const parsed = productOfferSegmentSchema.parse(segment);
      return [parsed.id, parsed] as const;
    }),
  );
  if (segments.size !== input.segments.length)
    throw new Error('duplicate immutable offer segment identity');
  const unique = new Set<string>();
  const capabilities = new Map<string, string[]>();
  const quotas = new Map<string, ProductAccessGrant[]>();
  for (const raw of input.grants) {
    const grant = productAccessGrantSchema.parse(raw);
    if (unique.has(grant.id)) throw new Error('duplicate access grant identity');
    unique.add(grant.id);
    if (
      grant.beneficiaryAccountId !== input.subjectAccountId ||
      grant.benefit.productId !== input.productId ||
      (grant.revokedAt !== null && Date.parse(grant.revokedAt) <= now) ||
      Date.parse(grant.period.start) > now ||
      Date.parse(grant.period.end) <= now
    )
      continue;
    const segment = segments.get(grant.sourceSegmentId);
    const source = segment && sources.get(segment.subscriptionId);
    if (
      !source ||
      !segment ||
      source.beneficiaryAccountId !== grant.beneficiaryAccountId ||
      segment.beneficiaryAccountId !== grant.beneficiaryAccountId ||
      segment.offerId !== grant.offerId ||
      segment.offerVersion !== grant.offerVersion ||
      segment.origin !== grant.origin ||
      Date.parse(grant.period.start) < Date.parse(segment.period.start) ||
      Date.parse(grant.period.end) > Date.parse(segment.period.end)
    ) {
      throw new Error('grant source provenance mismatch');
    }
    if (!['active', 'trialing'].includes(source.status) || Date.parse(source.period.end) <= now)
      continue;
    if (grant.benefit.kind === 'capability') {
      const ids = capabilities.get(grant.benefit.key) ?? [];
      ids.push(grant.id);
      capabilities.set(grant.benefit.key, ids);
    } else {
      const rows = quotas.get(grant.benefit.key) ?? [];
      rows.push(grant);
      quotas.set(grant.benefit.key, rows);
    }
  }
  const answer: SubjectProductAccess = {
    schemaVersion: 1,
    subjectAccountId: query.subjectAccountId,
    productId: query.productId,
    evaluatedAt: input.now.toISOString(),
    capabilities: [],
    quotas: [],
    conflicts: [],
  };
  for (const [key, ids] of capabilities) answer.capabilities.push({ key, grantIds: ids.sort() });
  for (const [key, grants] of quotas) {
    const benefits = grants
      .map((grant) => grant.benefit)
      .filter((benefit) => benefit.kind === 'quota');
    const [first] = benefits;
    const grantIds = grants.map((grant) => grant.id).sort();
    const units = new Set(benefits.map((benefit) => benefit.unit));
    const rules = new Set(benefits.map((benefit) => benefit.combination));
    let reason: SubjectProductAccess['conflicts'][number]['reason'] | undefined;
    if (units.size > 1) reason = 'unit_mismatch';
    else if (rules.size > 1) reason = 'combination_mismatch';
    else if (first.combination === 'exclusive' && benefits.length > 1) reason = 'exclusive_overlap';
    const included =
      first.combination === 'sum'
        ? benefits.reduce((sum, benefit) => sum + benefit.included, 0)
        : Math.max(...benefits.map((benefit) => benefit.included));
    if (!Number.isSafeInteger(included)) reason = 'unsafe_total';
    if (reason) answer.conflicts.push({ key, reason, grantIds });
    else
      answer.quotas.push({
        key,
        unit: first.unit,
        combination: first.combination,
        included,
        grantIds,
      });
  }
  answer.capabilities.sort((a, b) => a.key.localeCompare(b.key));
  answer.quotas.sort((a, b) => a.key.localeCompare(b.key));
  answer.conflicts.sort((a, b) => a.key.localeCompare(b.key));
  return subjectProductAccessSchema.parse(answer);
}
