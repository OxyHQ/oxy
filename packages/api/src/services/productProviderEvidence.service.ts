/** Unmounted adapter of explicit, trusted normalized data. No provider/network calls. */
import { createHash } from 'node:crypto';
import {
	productOfferSegmentSchema,
	productSubscriptionSourceSchema,
} from "@oxy.so/contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Transaction, getDb } from '../config/postgres';
import { accessProviderEvents, accessProviderPeriods } from '../db/schema';
import { ConflictError } from '../utils/error';
import { productProviderBindingSchema, recordProductAccessPeriod } from './productAccessPersistence.service';

const providerId = z.string().min(1).max(160);
const inputSchema = z.object({
  binding: productProviderBindingSchema,
  // No caller source/segment/evidence IDs or deduplication namespaces.
  subscription: z.unknown().transform(value => productSubscriptionSourceSchema.omit({ id: true }).parse(value)),
  offer: z.unknown().transform(value => productOfferSegmentSchema.pick({ offerId: true, offerVersion: true, origin: true }).parse(value)),
  paidLine: z.object({ invoiceId: providerId, lineId: providerId, priceId: providerId,
    quantity: z.literal(1), period: z.unknown().transform(value => productOfferSegmentSchema.shape.period.parse(value)) }).strict(),
  event: z.object({ id: providerId, createdAt: z.string().datetime() }).strict(),
  providerObservedAt: z.date(),
}).strict();
export type ProductProviderPeriodInput = z.infer<typeof inputSchema>;

/** Fixed JSON ordering, independent of database jsonb's object key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function same(actual: unknown, expected: unknown): void {
  if (canonical(actual) !== canonical(expected)) throw new ConflictError('Immutable provider evidence identity or payload differs');
}

/**
 * Paid recurring line -> immutable access period, atomically with its delivery mapping.
 * Input normalization is not provider authentication; a future verified adapter must
 * establish provider account/mode/environment and the unambiguous line externally.
 * Explicit registered offers only. This records no money, credits or legacy balance.
 */
export async function recordProductProviderPeriod(raw: ProductProviderPeriodInput,
	transaction?: Transaction,
	options: { verifiedHistoricalPaidEvidence?: boolean } = {},
) {
  const input = inputSchema.parse(raw);
  const binding = { provider: input.subscription.provider, ...input.binding };
  const sourceId = `access_source_${digest([binding, input.subscription.providerSubscriptionId])}`;
	const financialIdentity = { ...binding, invoiceId: input.paidLine.invoiceId, lineId: input.paidLine.lineId };
	const segmentId = `access_segment_${digest(financialIdentity)}`;
	const evidenceId = `access_evidence_${digest(financialIdentity)}`;
	// Freeze paid-period attribution, not arrival time or mutable current source state.
	const payload = { schemaVersion: 1, ...financialIdentity, sourceId, segmentId,
    providerSubscriptionId: input.subscription.providerSubscriptionId,
    beneficiaryAccountId: input.subscription.beneficiaryAccountId,
    payerAccountId: input.subscription.payerAccountId, priceId: input.paidLine.priceId,
    quantity: input.paidLine.quantity, ...input.offer, period: input.paidLine.period };
	const payloadSha256 = digest(payload);
	const eventPayload = { schemaVersion: 1, ...binding, eventId: input.event.id,
    eventCreatedAt: input.event.createdAt, evidenceId, sourceId, payloadSha256 };
	const eventPayloadSha256 = digest(eventPayload);

	const write = async (tx: Transaction) => {
		// Existing writer acquires sorted account -> application -> source locks FIRST.
		// No evidence/event lock precedes them, and no network runs under these locks.
		// Any later mismatch rolls back new segments/grants as well as ledger inserts.
		const access = await recordProductAccessPeriod(
			{
				source: { ...input.subscription, id: sourceId },
				segment: {
					schemaVersion: 1,
					id: segmentId,
					subscriptionId: sourceId,
					beneficiaryAccountId: input.subscription.beneficiaryAccountId,
					...input.offer,
					period: input.paidLine.period,
				},
				providerBinding: input.binding,
				providerObservedAt: input.providerObservedAt,
				advanceSourceSnapshot: true,
				allowHistoricalPaidSegment: options.verifiedHistoricalPaidEvidence,
			},
			tx,
		);
		const inserted = await tx
			.insert(accessProviderPeriods)
			.values({
				id: evidenceId,
				...financialIdentity,
				priceId: input.paidLine.priceId,
				sourceId,
				providerSubscriptionId: input.subscription.providerSubscriptionId,
				beneficiaryAccountId: input.subscription.beneficiaryAccountId,
				payerAccountId: input.subscription.payerAccountId,
				segmentId,
				...input.offer,
				periodStart: new Date(input.paidLine.period.start),
				periodEnd: new Date(input.paidLine.period.end),
				payload,
				payloadSha256,
			})
			.onConflictDoNothing()
			.returning({ id: accessProviderPeriods.id });
		const [period] = await tx
			.select()
			.from(accessProviderPeriods)
			.where(
				and(
					eq(accessProviderPeriods.provider, binding.provider),
					eq(
						accessProviderPeriods.providerAccountRef,
						binding.providerAccountRef,
					),
					eq(accessProviderPeriods.mode, binding.mode),
					eq(accessProviderPeriods.environment, binding.environment),
					eq(accessProviderPeriods.invoiceId, financialIdentity.invoiceId),
					eq(accessProviderPeriods.lineId, financialIdentity.lineId),
				),
			)
			.for("update");
		if (!period)
			throw new ConflictError("Provider period identity is unavailable");
		same(
			{
				id: period.id,
				sourceId: period.sourceId,
				segmentId: period.segmentId,
				payload: period.payload,
				payloadSha256: period.payloadSha256,
			},
			{ id: evidenceId, sourceId, segmentId, payload, payloadSha256 },
		);
		const delivered = await tx
			.insert(accessProviderEvents)
			.values({
				...binding,
				eventId: input.event.id,
				evidenceId,
				sourceId,
				payload: eventPayload,
				payloadSha256: eventPayloadSha256,
			})
			.onConflictDoNothing()
			.returning({ eventId: accessProviderEvents.eventId });
		const [event] = await tx
			.select()
			.from(accessProviderEvents)
			.where(
				and(
					eq(accessProviderEvents.provider, binding.provider),
					eq(
						accessProviderEvents.providerAccountRef,
						binding.providerAccountRef,
					),
					eq(accessProviderEvents.mode, binding.mode),
					eq(accessProviderEvents.environment, binding.environment),
					eq(accessProviderEvents.eventId, input.event.id),
				),
			)
			.for("update");
		if (!event)
			throw new ConflictError("Provider event identity is unavailable");
		same(
			{
				evidenceId: event.evidenceId,
				sourceId: event.sourceId,
				payload: event.payload,
				payloadSha256: event.payloadSha256,
			},
			{
				evidenceId,
				sourceId,
				payload: eventPayload,
				payloadSha256: eventPayloadSha256,
			},
		);
		return {
			status: inserted.length ? ("recorded" as const) : ("replayed" as const),
			eventStatus: delivered.length
				? ("recorded" as const)
				: ("replayed" as const),
			sourceId: period.sourceId,
			segmentId: period.segmentId,
			evidenceId: period.id,
			grantIds: access.grantIds,
		};
	};
	return transaction ? write(transaction) : getDb().transaction(write);
}
