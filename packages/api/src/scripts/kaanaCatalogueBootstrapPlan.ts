import { createHash } from "node:crypto";

export interface KaanaCatalogueBootstrapPlanInput {
	readonly reviewerUserId: string;
	readonly inventorySnapshotId: string;
	readonly reviewedFactsSha256: string;
	readonly publisher: string;
	readonly model: string;
	readonly revision: string;
	readonly candidate: {
		readonly modelReference: string;
		readonly priority: number;
	};
	readonly providers: readonly string[];
	readonly deployments: readonly string[];
	readonly routingProfileIds: readonly string[];
	readonly wouldInsert: readonly string[];
}

export interface KaanaCatalogueBootstrapPlan
	extends KaanaCatalogueBootstrapPlanInput {
	readonly schemaVersion: 1;
	readonly action: "bootstrap-kaana-catalogue";
	readonly databaseEngine: "postgresql";
}

export interface KaanaCatalogueBootstrapApplyAuthorization {
	readonly apply: boolean;
	readonly actualPlanSha256: string;
	readonly expectedPlanSha256: string;
	readonly actor: string;
	readonly reason: string;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalize(record[key])]),
		);
	}
	return value;
}

function isExactSingleLine(value: string, maximumLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maximumLength &&
		value === value.trim() &&
		!value.includes("\n") &&
		!value.includes("\r")
	);
}

function canonicalSha256(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)), "utf8")
		.digest("hex");
}

export function createKaanaCatalogueReviewedFactsSha256(
	reviewedFacts: unknown,
): string {
	return canonicalSha256(reviewedFacts);
}

export function createKaanaCatalogueBootstrapPlan(
	input: KaanaCatalogueBootstrapPlanInput,
): { readonly plan: KaanaCatalogueBootstrapPlan; readonly planSha256: string } {
	const plan: KaanaCatalogueBootstrapPlan = {
		schemaVersion: 1,
		action: "bootstrap-kaana-catalogue",
		databaseEngine: "postgresql",
		...input,
	};
	if (!/^[a-f0-9]{64}$/.test(plan.reviewedFactsSha256)) {
		throw new Error("Catalogue plan requires exact reviewed-facts SHA-256");
	}
	const planSha256 = canonicalSha256(plan);
	return { plan, planSha256 };
}

/**
 * Apply authorization is checked while the transaction still owns its lock.
 * The workflow is an additional control; this is what prevents a direct ECS
 * RunTask from applying a plan that was not reviewed first.
 */
export function requireKaanaCatalogueBootstrapApplyAuthorization(
	authorization: KaanaCatalogueBootstrapApplyAuthorization,
): void {
	if (!authorization.apply) return;
	if (!/^[a-f0-9]{64}$/.test(authorization.expectedPlanSha256)) {
		throw new Error(
			"Catalogue apply requires one exact lowercase SHA-256 plan",
		);
	}
	if (authorization.expectedPlanSha256 !== authorization.actualPlanSha256) {
		throw new Error(
			"Catalogue apply plan no longer matches its reviewed dry run",
		);
	}
	if (!isExactSingleLine(authorization.actor, 128)) {
		throw new Error(
			"Catalogue apply actor must be an exact non-empty single line",
		);
	}
	if (!isExactSingleLine(authorization.reason, 256)) {
		throw new Error(
			"Catalogue apply reason must be an exact non-empty single line",
		);
	}
}
