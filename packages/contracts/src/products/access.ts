import { z } from 'zod';
import { oxyAccountIdSchema, oxyApplicationIdSchema } from '../inference/identifiers';

const identifier = z.string().min(1).max(160);
const count = z.number().int().nonnegative().safe();
const period = z.object({ start: z.string().datetime(), end: z.string().datetime() }).strict()
    .refine(value => Date.parse(value.end) > Date.parse(value.start), 'period end must follow start');

/** Product ownership and audience are registered together; branding grants no trust. */
export const productDefinitionSchema = z.object({
    schemaVersion: z.literal(1), id: identifier, ownerAccountId: oxyAccountIdSchema,
    applicationId: oxyApplicationIdSchema,
}).strict();

export const subjectProductAccessQuerySchema = z.object({
    schemaVersion: z.literal(1), subjectAccountId: oxyAccountIdSchema, productId: identifier,
}).strict();

/** Every quota declares its combination rule; there is no commercial default. */
export const productBenefitSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('capability'), productId: identifier, key: identifier }).strict(),
    z.object({ kind: z.literal('quota'), productId: identifier, key: identifier,
        unit: identifier, included: count, combination: z.enum(['maximum', 'sum', 'exclusive']) }).strict(),
]);

/** A version names a frozen offer. An empty bundle grants nothing. */
export const productOfferSchema = z.object({
    schemaVersion: z.literal(1), id: identifier, version: z.number().int().positive().safe(),
    kind: z.enum(['individual', 'bundle']), benefits: z.array(productBenefitSchema),
}).strict().refine(value => value.kind === 'bundle' || new Set(value.benefits.map(benefit => benefit.productId)).size <= 1,
    'individual offers cannot cover multiple products');

export const productSubscriptionSourceSchema = z.object({
    schemaVersion: z.literal(1), id: identifier,
    beneficiaryAccountId: oxyAccountIdSchema, payerAccountId: oxyAccountIdSchema,
    provider: z.enum(['stripe', 'peable']), providerSubscriptionId: identifier,
    status: z.enum(['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'paused', 'incomplete', 'incomplete_expired']),
    period, cancelAtPeriodEnd: z.boolean(),
}).strict();

/** A frozen paid-period/offer segment; upgrades append, never rewrite it. */
export const productOfferSegmentSchema = z.object({
    schemaVersion: z.literal(1), id: identifier, subscriptionId: identifier,
    beneficiaryAccountId: oxyAccountIdSchema, offerId: identifier,
    offerVersion: z.number().int().positive().safe(), origin: z.enum(['individual', 'bundle']), period,
}).strict();

/** Provenance survives cancellation: deactivate a source, never delete history. */
export const productAccessGrantSchema = z.object({
    schemaVersion: z.literal(1), id: identifier, sourceSegmentId: identifier,
    beneficiaryAccountId: oxyAccountIdSchema, offerId: identifier,
    offerVersion: z.number().int().positive().safe(),
    origin: z.enum(['individual', 'bundle']), benefit: productBenefitSchema,
    period, revokedAt: z.string().datetime().nullable(),
}).strict();

/** Access answers contain no payer, provider reference, price or account balance. */
export const subjectProductAccessSchema = z.object({
    schemaVersion: z.literal(1), subjectAccountId: oxyAccountIdSchema, productId: identifier,
    evaluatedAt: z.string().datetime(),
    capabilities: z.array(z.object({ key: identifier, grantIds: z.array(identifier) }).strict()),
    quotas: z.array(z.object({ key: identifier, unit: identifier, included: count,
        combination: z.enum(['maximum', 'sum', 'exclusive']), grantIds: z.array(identifier) }).strict()),
    conflicts: z.array(z.object({ key: identifier,
        reason: z.enum(['combination_mismatch', 'unit_mismatch', 'exclusive_overlap', 'unsafe_total']),
        grantIds: z.array(identifier) }).strict()),
}).strict();

export type ProductBenefit = z.infer<typeof productBenefitSchema>;
export type ProductOffer = z.infer<typeof productOfferSchema>;
export type ProductSubscriptionSource = z.infer<typeof productSubscriptionSourceSchema>;
export type ProductOfferSegment = z.infer<typeof productOfferSegmentSchema>;
export type ProductAccessGrant = z.infer<typeof productAccessGrantSchema>;
export type SubjectProductAccess = z.infer<typeof subjectProductAccessSchema>;

export type ProductDefinition = z.infer<typeof productDefinitionSchema>;
export type SubjectProductAccessQuery = z.infer<typeof subjectProductAccessQuerySchema>;
