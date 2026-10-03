/** Administrative preparation only: no bootstrap, timers, AWS writes or automatic old restart. */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { closePostgres, connectPostgres, getDb } from "../config/postgres";
import sessionService from "../services/session.service";

const id = z.string().min(1).max(256);
const revision = z.string().regex(/^[0-9]+$/);
const timestamp = z.string().datetime();
const method = {
	auth_method_id: id.nullable(),
	auth_method_owner_id: id.nullable(),
};
const sessionRow = z
	.object({
		id,
		session_id: id,
		user_id: id,
		operated_by_user_id: id.nullable(),
		application_id: id.nullable(),
		...method,
		is_active: z.boolean(),
		expires_at: timestamp,
		xmin: revision,
		authority_sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const codeRow = z
	.object({
		id,
		user_id: id,
		operated_by_user_id: id.nullable(),
		application_id: id,
		...method,
		used_at: timestamp.nullable(),
		expires_at: timestamp,
		xmin: revision,
		authority_sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const approvalRow = z
	.object({
		id,
		application_id: id,
		approved_by_session_id: id,
		authorized_user_id: id.nullable(),
		authorized_session_id: id.nullable(),
		finalized_auth_code_id: id.nullable(),
		purpose: z.literal("oauth_authorization"),
		status: z.enum([
			"pending",
			"authorized",
			"consumed",
			"cancelled",
			"expired",
		]),
		expires_at: timestamp,
		xmin: revision,
		authority_sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const snapshotSchema = z
	.object({
		sessions: z.array(sessionRow).max(1000),
		codes: z.array(codeRow).max(1000),
		approvals: z.array(approvalRow).max(1000),
	})
	.strict();
const stoppedService = z
	.object({
		name: id,
		taskDefinition: id,
		desiredCount: z.literal(0),
		runningCount: z.literal(0),
		pendingCount: z.literal(0),
		capturedTasks: z.array(id).max(100),
		stoppedTasks: z.array(id).max(100),
		targetGroups: z.array(id).max(20),
		drainedTargetGroups: z.array(id).max(20),
		scaling: z
			.object({
				DynamicScalingInSuspended: z.literal(true),
				DynamicScalingOutSuspended: z.literal(true),
				ScheduledScalingSuspended: z.literal(true),
			})
			.strict()
			.nullable(),
	})
	.strict();
export const oldIssuerQuiescenceSchema = z
	.object({
		kind: z.literal("old-issuer-quiescence-readback"),
		observedAt: timestamp,
		maintenancePlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
		services: z.array(stoppedService).min(1).max(40),
		standaloneWriters: z.array(id).max(0),
		admissionProbes: z
			.array(z.object({ path: id, status: z.literal(503) }).strict())
			.min(2)
			.max(30),
	})
	.strict();
export type OldIssuerQuiescence = z.infer<typeof oldIssuerQuiescenceSchema>;
const planSchema = z
	.object({
		kind: z.literal("old-issuer-auth-retirement"),
		schemaVersion: z.literal(1),
		nonce: z.string().regex(/^[a-f0-9]{32}$/),
		preparedAt: timestamp,
		expiresAt: timestamp,
		maintenancePlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
		affectedServices: z
			.array(
				z
					.object({
						name: id,
						taskDefinition: id,
						targetGroups: z.array(id).max(20),
						hasScaling: z.boolean(),
						capturedTasks: z.array(id).max(100),
					})
					.strict(),
			)
			.min(1)
			.max(40),
		admissionPaths: z.array(id).min(2).max(30),
		provenanceLostSessionIds: z.array(id).max(100),
		snapshot: snapshotSchema,
		snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
		productionReady: z.literal(false),
	})
	.strict();
export type OldIssuerAuthRetirementPlan = z.infer<typeof planSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type ReadDb = Pick<ReturnType<typeof getDb>, "execute">;
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sameSet(a: string[], b: string[]): boolean {
	return (
		new Set(a).size === a.length &&
		new Set(b).size === b.length &&
		JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
	);
}
function fail(): never {
	throw new Error("OLD_ISSUER_AUTH_RETIREMENT_REVIEW_REQUIRED");
}
export function validateOldIssuerQuiescence(
	input: unknown,
	plan: OldIssuerAuthRetirementPlan,
): OldIssuerQuiescence {
	const receipt = oldIssuerQuiescenceSchema.parse(input);
	const age = Date.now() - Date.parse(receipt.observedAt);
	if (
		age < 0 ||
		age > 60_000 ||
		receipt.maintenancePlanSha256 !== plan.maintenancePlanSha256 ||
		!sameSet(
			receipt.services.map((r) => r.name),
			plan.affectedServices.map((r) => r.name),
		)
	)
		fail();
	for (const expected of plan.affectedServices) {
		const row = receipt.services.find((r) => r.name === expected.name);
		if (
			!row ||
			row.taskDefinition !== expected.taskDefinition ||
			Boolean(row.scaling) !== expected.hasScaling ||
			!sameSet(row.capturedTasks, expected.capturedTasks) ||
			!sameSet(row.capturedTasks, row.stoppedTasks) ||
			!sameSet(row.targetGroups, expected.targetGroups) ||
			!sameSet(row.targetGroups, row.drainedTargetGroups)
		)
			fail();
	}
	if (
		!sameSet(
			receipt.admissionProbes.map((r) => r.path),
			plan.admissionPaths,
		)
	)
		fail();
	return receipt;
}
function checkedPlan(input: unknown): OldIssuerAuthRetirementPlan {
	const plan = planSchema.parse(input);
	const lifetime = Date.parse(plan.expiresAt) - Date.parse(plan.preparedAt);
	if (
		lifetime <= 0 ||
		lifetime > 30 * 60_000 ||
		Date.parse(plan.preparedAt) > Date.now() ||
		Date.parse(plan.expiresAt) <= Date.now() ||
		digest(plan.snapshot) !== plan.snapshotSha256 ||
		!sameSet(plan.provenanceLostSessionIds, plan.provenanceLostSessionIds) ||
		!sameSet(
			plan.affectedServices.map((r) => r.name),
			plan.affectedServices.map((r) => r.name),
		)
	)
		fail();
	for (const table of Object.values(plan.snapshot)) {
		if (
			!sameSet(
				table.map((r) => r.id),
				table.map((r) => r.id),
			)
		)
			fail();
	}
	return plan;
}
/** Explicit reviewed accidental-issuance IDs only; NULL provenance is never guessed from username/time. */
async function snapshot(
	db: ReadDb,
	lost: string[],
	lock = false,
): Promise<Snapshot> {
	const lostPredicate = lost.length
		? sql`or session_id in (${sql.join(
				lost.map((v) => sql`${v}`),
				sql`, `,
			)})`
		: sql``;
	const suffix = lock ? sql`for update` : sql``;
	const sessionRows =
		await db.execute(sql`select id, session_id, user_id, operated_by_user_id, application_id,
    auth_method_id, auth_method_owner_id, is_active,
    to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,
    xmin::text as xmin, encode(sha256(convert_to((to_jsonb(sessions) - 'is_active' - 'updated_at')::text, 'UTF8')), 'hex') as authority_sha256 from sessions where auth_method_id is not null ${lostPredicate}
    order by id limit 1001 ${suffix}`);
	const codeRows =
		await db.execute(sql`select id, user_id, operated_by_user_id, application_id,
    auth_method_id, auth_method_owner_id,
    to_char(used_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as used_at,
    to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,
    xmin::text as xmin, encode(sha256(convert_to((to_jsonb(auth_codes) - 'expires_at')::text, 'UTF8')), 'hex') as authority_sha256 from auth_codes where auth_method_id is not null or id in (select finalized_auth_code_id from auth_sessions
      where purpose = 'oauth_authorization' and approved_by_session_id in
      (select session_id from sessions where auth_method_id is not null ${lostPredicate})) order by id limit 1001 ${suffix}`);
	const approvalRows =
		await db.execute(sql`select id, application_id, approved_by_session_id,
    authorized_user_id, authorized_session_id, finalized_auth_code_id, purpose, status,
    to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at,
    xmin::text as xmin, encode(sha256(convert_to((to_jsonb(auth_sessions) - 'expires_at' - 'status')::text, 'UTF8')), 'hex') as authority_sha256 from auth_sessions where purpose = 'oauth_authorization'
    and approved_by_session_id in (select session_id from sessions where auth_method_id is not null ${lostPredicate})
    order by id limit 1001 ${suffix}`);
	const result = snapshotSchema.parse({
		sessions: sessionRows,
		codes: codeRows,
		approvals: approvalRows,
	});
	if (!lost.every((v) => result.sessions.some((r) => r.session_id === v)))
		fail();
	return result;
}
export async function prepareOldIssuerAuthRetirement(input: {
	maintenancePlanSha256: string;
	admissionPaths: string[];
	affectedServices: OldIssuerAuthRetirementPlan["affectedServices"];
	provenanceLostSessionIds?: string[];
}): Promise<OldIssuerAuthRetirementPlan> {
	const lost = input.provenanceLostSessionIds ?? [];
	const observed = await getDb().transaction(async (tx) => {
		await tx.execute(
			sql`set transaction isolation level repeatable read read only`,
		);
		await tx.execute(sql`set local statement_timeout = '10s'`);
		return snapshot(tx, lost);
	});
	const now = new Date();
	return checkedPlan({
		kind: "old-issuer-auth-retirement",
		schemaVersion: 1,
		nonce: randomBytes(16).toString("hex"),
		preparedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
		...input,
		provenanceLostSessionIds: lost,
		snapshot: observed,
		snapshotSha256: digest(observed),
		productionReady: false,
	});
}
function preserved(
	original: Snapshot,
	current: Snapshot,
	completed: boolean,
): boolean {
	const copy = structuredClone(current);
	for (const key of ["sessions", "codes", "approvals"] as const) {
		if (
			!sameSet(
				original[key].map((r) => r.id),
				copy[key].map((r) => r.id),
			)
		)
			return false;
	}
	for (const row of copy.sessions) {
		const before = original.sessions.find((r) => r.id === row.id);
		if (!before) return false;
		const inactive = !row.is_active;
		if (before.is_active && inactive) row.xmin = before.xmin;
		if (completed && before.is_active && !inactive) return false;
		if (inactive) row.is_active = before.is_active;
	}
	for (const row of copy.codes) {
		const before = original.codes.find((r) => r.id === row.id);
		if (!before) return false;
		const expired = Date.parse(row.expires_at) <= Date.now();
		if (row.expires_at !== before.expires_at) {
			if (before.used_at !== null || !expired) return false;
			row.expires_at = before.expires_at;
			row.xmin = before.xmin;
		}
		if (completed && before.used_at === null && !expired) return false;
	}
	for (const row of copy.approvals) {
		const before = original.approvals.find((r) => r.id === row.id);
		if (!before) return false;
		const ended =
			!["pending", "authorized"].includes(row.status) ||
			Date.parse(row.expires_at) <= Date.now();
		if (completed && !ended) return false;
		if (row.status !== before.status || row.expires_at !== before.expires_at) {
			if (
				!["pending", "authorized"].includes(before.status) ||
				row.status !== "expired" ||
				Date.parse(row.expires_at) > Date.now()
			)
				return false;
			row.status = before.status;
			row.expires_at = before.expires_at;
			row.xmin = before.xmin;
		}
	}
	return digest(copy) === digest(original);
}
/** Recorder must fsync intent/confirmations outside the checkout. Observer performs fresh GETs,
 * never a preflight copy. There is intentionally no CLI execution without this transport. */
export async function retireOldIssuerAuth(
	input: unknown,
	observeQuiescence: () => Promise<unknown>,
	record: (entry: {
		phase: string;
		nonce: string;
		id?: string;
	}) => Promise<void>,
): Promise<void> {
	const plan = checkedPlan(input);
	const fresh = async () => {
		checkedPlan(plan);
		validateOldIssuerQuiescence(await observeQuiescence(), plan);
		checkedPlan(plan);
	};
	await fresh();
	await record({ phase: "authorizations-expiry-intent", nonce: plan.nonce });
	await fresh();
	await getDb().transaction(async (tx) => {
		await tx.execute(sql`set local statement_timeout = '10s'`);
		await tx.execute(sql`set local lock_timeout = '3s'`);
		const current = await snapshot(tx, plan.provenanceLostSessionIds, true);
		if (!preserved(plan.snapshot, current, false)) fail();
		for (const row of current.codes) {
			if (row.used_at !== null || Date.parse(row.expires_at) <= Date.now())
				continue;
			const result =
				await tx.execute(sql`update auth_codes set expires_at = clock_timestamp() where id = ${row.id}
        and xmin::text = ${row.xmin} and used_at is null returning id`);
			if (result.length !== 1) fail();
		}
		for (const row of current.approvals) {
			if (
				!["pending", "authorized"].includes(row.status) ||
				Date.parse(row.expires_at) <= Date.now()
			)
				continue;
			const result =
				await tx.execute(sql`update auth_sessions set status = 'expired', expires_at = clock_timestamp()
        where id = ${row.id} and xmin::text = ${row.xmin} returning id`);
			if (result.length !== 1) fail();
		}
	});
	await record({
		phase: "authorizations-expired-confirmed",
		nonce: plan.nonce,
	});
	for (const row of plan.snapshot.sessions) {
		await fresh();
		const current = await snapshot(getDb(), plan.provenanceLostSessionIds);
		if (!preserved(plan.snapshot, current, false)) fail();
		const live = current.sessions.find((r) => r.id === row.id);
		if (!live) fail();
		if (!live.is_active) continue;
		await record({
			phase: "session-retirement-intent",
			nonce: plan.nonce,
			id: row.id,
		});
		await fresh();
		if (
			!(await sessionService.deactivateSession(row.session_id, {
				expectedXmin: live.xmin,
			}))
		)
			fail();
		await record({
			phase: "session-retired-confirmed",
			nonce: plan.nonce,
			id: row.id,
		});
	}
	await fresh();
	if (
		!preserved(
			plan.snapshot,
			await snapshot(getDb(), plan.provenanceLostSessionIds),
			true,
		)
	)
		fail();
	await record({
		phase: "auth-retirement-confirmed-maintenance-required",
		nonce: plan.nonce,
	});
}

// Default CLI only prepares a repeatable-read SQL plan. No execute flag exists.
if (require.main === module) {
	const [command, path] = process.argv.slice(2);
	if (command !== "prepare" || !path || process.argv.length !== 4) {
		process.stderr.write(
			"Usage: oldIssuerAuthRetirement.js prepare <reviewed-maintenance-input.json>\n",
		);
		process.exitCode = 1;
	} else {
		Promise.resolve()
			.then(async () => {
				const input = z
					.object({
						maintenancePlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
						affectedServices: planSchema.shape.affectedServices,
						admissionPaths: planSchema.shape.admissionPaths,
						provenanceLostSessionIds: z.array(id).max(100).optional(),
					})
					.strict()
					.parse(JSON.parse(readFileSync(path, "utf8")));
				await connectPostgres();
				process.stdout.write(
					`${JSON.stringify(await prepareOldIssuerAuthRetirement(input))}\n`,
				);
			})
			.catch(() => {
				process.stderr.write("OLD_ISSUER_AUTH_PREPARATION_FAILED\n");
				process.exitCode = 1;
			})
			.finally(closePostgres);
	}
}
