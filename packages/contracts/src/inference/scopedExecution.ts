import { z } from "zod";
import {
	deploymentIdSchema,
	idempotencyKeySchema,
	inferenceEnvironmentSchema,
	inferenceProviderSlugSchema,
	modelReferenceSchema,
	requestIdSchema,
} from "./identifiers";
import { exactDecimalSchema } from "./money";

/** Explicit extension negotiation; never replaces the legacy 3.5 handshake. */
export const SCOPED_EXECUTION_CONTRACT_VERSION = "3.6.0" as const;
/** Scoped only; normal envelope v2 and metadata 3.5 remain unchanged. */
export const SCOPED_REQUEST_ENVELOPE_VERSION = 3 as const;
const identity = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const maxCost = exactDecimalSchema.refine((value) => {
	if (!exactDecimalSchema.safeParse(value).success) return false;
	const [whole, fraction = ""] = value.split(".");
	const units =
		BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
	return units > 0n && units <= 10_000_000_000n;
}, "scoped cost must be positive and at most 0.01 USD");

/** Restriction only: none of these identities grants catalogue eligibility. */
export const scopedExecutionAudienceSchema = z
	.object({
		permitId: identity,
		idempotencyKey: idempotencyKeySchema,
		fixtureSha256: sha256,
		expiresAt: z.string().datetime(),
		principal: z
			.object({
				accountId: identity,
				applicationId: identity,
				credentialId: identity,
				environment: inferenceEnvironmentSchema,
			})
			.strict(),
		policy: z
			.object({
				routingPolicyId: z.string().min(1).max(128),
				policyVersion: z.number().int().positive().safe(),
			})
			.strict(),
		deploymentId: deploymentIdSchema,
		provider: inferenceProviderSlugSchema,
		keyId: identity,
		modelReference: modelReferenceSchema.refine(
			(value) => value.includes("@"),
			"must pin a revision",
		),
		upstreamModelId: identity,
		priceVersionId: identity,
		providerRateCardVersionId: identity,
		providerSourceVersion: identity,
		maxCostUsd: maxCost,
	})
	.strict();

export const scopedExecutionSchema = scopedExecutionAudienceSchema
	.extend({
		requestId: requestIdSchema,
		snapshotId: identity,
		catalogueEvidenceHash: sha256,
	})
	.strict();

export type ScopedExecutionAudience = z.infer<
	typeof scopedExecutionAudienceSchema
>;
export type ScopedExecution = z.infer<typeof scopedExecutionSchema>;

/**
 * Canonical JSON wire bytes: recursive UTF-16 key order, JSON string/number
 * encoding, arrays in order, no whitespace. Hash the whole signed input, not a
 * reparsed/defaulted decision. Reject non-JSON values rather than dropping them.
 */
export function canonicalScopedExecutionJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value)) {
		const entries = Array.from(value, (entry, index) => {
			if (!(index in value))
				throw new Error("Scoped execution requires dense JSON arrays.");
			return canonicalScopedExecutionJson(entry);
		});
		return `[${entries.join(",")}]`;
	}
	if (
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		const entries = Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalScopedExecutionJson((value as Record<string, unknown>)[key])}`,
			);
		return `{${entries.join(",")}}`;
	}
	throw new Error("Scoped execution requires JSON wire values.");
}
