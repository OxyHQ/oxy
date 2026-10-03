import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { applications } from "../../db/schema/applications";
import { authCodes } from "../../db/schema/authCodes";
import { authSessions } from "../../db/schema/authSessions";
import { sessions } from "../../db/schema/sessions";
import { userAuthMethods } from "../../db/schema/userAuthMethods";
import { users } from "../../db/schema/users";
import { createTestDatabase, dropTestDatabase } from "../../db/testDatabase";
import sessionService from "../../services/session.service";
import {
	type OldIssuerAuthRetirementPlan,
	prepareOldIssuerAuthRetirement,
	retireOldIssuerAuth,
	validateOldIssuerQuiescence,
} from "../oldIssuerAuthRetirement";

const originalDatabaseUrl = process.env.DATABASE_URL;
let ownDatabaseUrl: string | undefined;
jest.setTimeout(60_000);
beforeAll(async () => {
	// Retirement intentionally inventories global authority. Preserve that
	// production scope while giving this suite its own fully migrated database.
	ownDatabaseUrl = await createTestDatabase();
	await connectPostgres();
});
afterAll(async () => {
	try {
		await closePostgres();
	} finally {
		try {
			if (ownDatabaseUrl) await dropTestDatabase(ownDatabaseUrl);
		} finally {
			if (originalDatabaseUrl === undefined)
				Reflect.deleteProperty(process.env, "DATABASE_URL");
			else process.env.DATABASE_URL = originalDatabaseUrl;
		}
	}
});
const maintenancePlanSha256 = "a".repeat(64);
const affectedServices = [
	{
		name: "oxy-api",
		taskDefinition: "fixture:692",
		targetGroups: ["fixture-tg"],
		hasScaling: true,
		capturedTasks: ["fixture-task"],
	},
];
const fixtureUsers: string[] = [];
let appId: string;
let agentSessionId: string;
let humanSessionId: string;
let lostSessionId: string;
let agentRowId: string;
let agentCodeId: string;
let humanCodeId: string;
let approvalId: string;
let humanApprovalId: string;
beforeEach(async () => {
	const [bot] = await getDb()
		.insert(users)
		.values({
			kind: "bot",
			username: `retire${randomUUID().replaceAll("-", "")}`,
		})
		.returning();
	const [human] = await getDb()
		.insert(users)
		.values({ username: `retire${randomUUID().replaceAll("-", "")}` })
		.returning();
	fixtureUsers.push(bot.id, human.id);
	const [key] = await getDb()
		.insert(userAuthMethods)
		.values({
			userId: bot.id,
			type: "agent_key",
			methodPublicKey: randomUUID(),
			label: "retirement fixture",
			enrollmentMethod: "governor",
		})
		.returning();
	const [app] = await getDb()
		.insert(applications)
		.values({
			name: "Retirement fixture",
			type: "internal",
			ownerAccountId: human.id,
		})
		.returning();
	appId = app.id;
	const expiry = new Date(Date.now() + 60 * 60_000);
	agentSessionId = randomUUID();
	humanSessionId = randomUUID();
	lostSessionId = randomUUID();
	const created = await getDb()
		.insert(sessions)
		.values([
			{
				sessionId: agentSessionId,
				userId: bot.id,
				deviceId: randomUUID(),
				deviceType: "web",
				platform: "web",
				accessToken: "agent-fixture-token",
				refreshToken: "agent-fixture-refresh",
				expiresAt: expiry,
				authMethodId: key.id,
				authMethodOwnerId: bot.id,
			},
			{
				sessionId: humanSessionId,
				userId: human.id,
				deviceId: randomUUID(),
				deviceType: "web",
				platform: "web",
				accessToken: "human-fixture-token",
				refreshToken: "human-fixture-refresh",
				expiresAt: expiry,
			},
			{
				sessionId: lostSessionId,
				userId: bot.id,
				deviceId: randomUUID(),
				deviceType: "web",
				platform: "web",
				accessToken: "lost-fixture-token",
				refreshToken: "lost-fixture-refresh",
				expiresAt: expiry,
			},
		])
		.returning();
	agentRowId = created[0].id;
	const codes = await getDb()
		.insert(authCodes)
		.values([
			{
				userId: bot.id,
				applicationId: appId,
				redirectUri: "https://fixture.invalid/callback",
				codeHash: randomUUID(),
				expiresAt: expiry,
				authMethodId: key.id,
				authMethodOwnerId: bot.id,
			},
			{
				userId: human.id,
				applicationId: appId,
				redirectUri: "https://fixture.invalid/callback",
				codeHash: randomUUID(),
				expiresAt: expiry,
			},
		])
		.returning();
	agentCodeId = codes[0].id;
	humanCodeId = codes[1].id;
	const approvals = await getDb()
		.insert(authSessions)
		.values([
			{
				sessionToken: randomUUID(),
				applicationId: appId,
				purpose: "oauth_authorization",
				status: "authorized",
				approvedBySessionId: agentSessionId,
				authorizedUserId: bot.id,
				oauthRedirectUri: "https://fixture.invalid/callback",
				oauthCodeChallenge: "fixture-challenge",
				oauthCodeChallengeMethod: "S256",
				oauthScopes: [],
				expiresAt: expiry,
			},
			{
				sessionToken: randomUUID(),
				applicationId: appId,
				purpose: "oauth_authorization",
				status: "authorized",
				approvedBySessionId: humanSessionId,
				authorizedUserId: human.id,
				oauthRedirectUri: "https://fixture.invalid/callback",
				oauthCodeChallenge: "fixture-challenge",
				oauthCodeChallengeMethod: "S256",
				oauthScopes: [],
				expiresAt: expiry,
			},
		])
		.returning();
	approvalId = approvals[0].id;
	humanApprovalId = approvals[1].id;
});
afterEach(async () => {
	await getDb().execute(
		sql`drop trigger if exists retirement_fixture_failure on auth_sessions`,
	);
	await getDb().execute(
		sql`drop function if exists retirement_fixture_failure()`,
	);
	await getDb()
		.delete(authSessions)
		.where(eq(authSessions.applicationId, appId));
	await getDb().delete(authCodes).where(eq(authCodes.applicationId, appId));
	await getDb().delete(sessions).where(inArray(sessions.userId, fixtureUsers));
	await getDb()
		.delete(userAuthMethods)
		.where(inArray(userAuthMethods.userId, fixtureUsers));
	await getDb().delete(applications).where(eq(applications.id, appId));
	await getDb().delete(users).where(inArray(users.id, fixtureUsers));
	fixtureUsers.length = 0;
});
function prepare(lost: string[] = []) {
	return prepareOldIssuerAuthRetirement({
		maintenancePlanSha256,
		admissionPaths: ["/auth/password", "/internal/admission"],
		affectedServices,
		provenanceLostSessionIds: lost,
	});
}
function quiescence(plan: OldIssuerAuthRetirementPlan) {
	return {
		kind: "old-issuer-quiescence-readback",
		observedAt: new Date().toISOString(),
		maintenancePlanSha256: plan.maintenancePlanSha256,
		standaloneWriters: [],
		admissionProbes: [
			{ path: "/auth/password", status: 503 },
			{ path: "/internal/admission", status: 503 },
		],
		services: [
			{
				name: "oxy-api",
				taskDefinition: "fixture:692",
				desiredCount: 0,
				runningCount: 0,
				pendingCount: 0,
				capturedTasks: ["fixture-task"],
				stoppedTasks: ["fixture-task"],
				targetGroups: ["fixture-tg"],
				drainedTargetGroups: ["fixture-tg"],
				scaling: {
					DynamicScalingInSuspended: true,
					DynamicScalingOutSuspended: true,
					ScheduledScalingSuspended: true,
				},
			},
		],
	};
}
const record = async () => {};
async function run(plan: OldIssuerAuthRetirementPlan, recorder = record) {
	return retireOldIssuerAuth(plan, async () => quiescence(plan), recorder);
}
async function rowState() {
	const [code] = await getDb()
		.select()
		.from(authCodes)
		.where(eq(authCodes.id, agentCodeId));
	const [approval] = await getDb()
		.select()
		.from(authSessions)
		.where(eq(authSessions.id, approvalId));
	const [agent] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.id, agentRowId));
	return { code, approval, agent };
}
it("preparation is read-only, bounded and excludes secrets and ordinary/lost rows unless explicitly inventoried", async () => {
	const before = await rowState();
	const plan = await prepare();
	expect(await rowState()).toEqual(before);
	expect(plan.snapshot.sessions.map((r) => r.session_id)).toEqual([
		agentSessionId,
	]);
	expect(plan.snapshot.codes.map((r) => r.id)).toEqual([agentCodeId]);
	expect(plan.snapshot.approvals.map((r) => r.id)).toEqual([approvalId]);
	expect(JSON.stringify(plan)).not.toContain("fixture-token");
	expect(JSON.stringify(plan)).not.toContain("fixture-refresh");
	expect(plan.productionReady).toBe(false);
});
it("expires exact pending authority, retires agent and cache canonically, retains history and unrelated human authority", async () => {
	const plan = await prepare();
	expect(await sessionService.getSession(agentSessionId)).not.toBeNull();
	expect(await sessionService.getSession(humanSessionId)).not.toBeNull();
	const phases: string[] = [];
	await run(plan, async (event) => {
		phases.push(event.phase);
	});
	const after = await rowState();
	expect(after.agent.isActive).toBe(false);
	expect(after.agent.authMethodId).toBe(
		plan.snapshot.sessions[0].auth_method_id,
	);
	expect(after.approval.approvedBySessionId).toBe(agentSessionId);
	expect(after.approval.status).toBe("expired");
	expect(after.code.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
	expect(await sessionService.getSession(agentSessionId)).toBeNull();
	expect(await sessionService.getSession(humanSessionId)).not.toBeNull();
	const [hc] = await getDb()
		.select()
		.from(authCodes)
		.where(eq(authCodes.id, humanCodeId));
	const [ha] = await getDb()
		.select()
		.from(authSessions)
		.where(eq(authSessions.id, humanApprovalId));
	expect(hc.expiresAt.getTime()).toBeGreaterThan(Date.now());
	expect(ha.status).toBe("authorized");
	expect(phases.at(-1)).toBe("auth-retirement-confirmed-maintenance-required");
	await run(plan);
	expect(await rowState()).toEqual(after);
});
it("canonical xmin mismatch rejects before retirement, existing ordinary callers keep false/true behavior", async () => {
	const plan = await prepare();
	const version = plan.snapshot.sessions[0].xmin;
	await getDb()
		.update(sessions)
		.set({ scopes: ["user:read"] })
		.where(eq(sessions.id, agentRowId));
	await expect(
		sessionService.deactivateSession(agentSessionId, { expectedXmin: version }),
	).rejects.toThrow("CAS_MISMATCH");
	expect((await rowState()).agent.isActive).toBe(true);
	await expect(
		sessionService.deactivateSession(agentSessionId, {
			expectedXmin: "1 OR 1=1",
		}),
	).rejects.toThrow("CAS_INVALID");
	expect(await sessionService.deactivateSession(humanSessionId)).toBe(true);
	expect(await sessionService.deactivateSession(humanSessionId)).toBe(false);
});
it("scope/token rotation or added agent rows cause prewrite CAS rejection", async () => {
	const plan = await prepare();
	await getDb()
		.update(authCodes)
		.set({ scopes: ["user:read"] })
		.where(eq(authCodes.id, agentCodeId));
	await expect(run(plan)).rejects.toThrow("REVIEW_REQUIRED");
	const current = await rowState();
	expect(current.agent.isActive).toBe(true);
	expect(current.approval.status).toBe("authorized");
});
it("new agent authority after snapshot rejects the target census before any expiry", async () => {
	const plan = await prepare();
	const [code] = await getDb()
		.select()
		.from(authCodes)
		.where(eq(authCodes.id, agentCodeId));
	await getDb()
		.insert(authCodes)
		.values({ ...code, id: randomUUID(), codeHash: randomUUID() });
	await expect(run(plan)).rejects.toThrow("REVIEW_REQUIRED");
	expect((await rowState()).code.expiresAt.getTime()).toBeGreaterThan(
		Date.now(),
	);
});
it("failure in approval update rolls back preceding code expiry and leaves sessions active", async () => {
	const plan = await prepare();
	const before = await rowState();
	await getDb().execute(sql`create function retirement_fixture_failure() returns trigger language plpgsql as
    'begin raise exception ''fixture rollback''; end;'`);
	await getDb().execute(sql`create trigger retirement_fixture_failure before update on auth_sessions
    for each row execute function retirement_fixture_failure()`);
	await expect(run(plan)).rejects.toMatchObject({ cause: { code: "P0001" } });
	expect(await rowState()).toEqual(before);
});
it("lost confirmation after SQL expiry can resume without reviving/deleting history", async () => {
	const plan = await prepare();
	await expect(
		run(plan, async (event) => {
			if (event.phase === "authorizations-expired-confirmed")
				throw new Error("lost durable ack");
		}),
	).rejects.toThrow("lost durable ack");
	expect((await rowState()).agent.isActive).toBe(true);
	expect((await rowState()).approval.status).toBe("expired");
	await run(plan);
	expect((await rowState()).agent.isActive).toBe(false);
});
it("loss of quiescence after intent halts before the next effect, recovery remains maintenance-only", async () => {
	const plan = await prepare();
	let changed = false;
	await expect(
		retireOldIssuerAuth(
			plan,
			async () => {
				const receipt = quiescence(plan);
				if (changed) receipt.services[0].runningCount = 1;
				return receipt;
			},
			async (event) => {
				if (event.phase === "session-retirement-intent") changed = true;
			},
		),
	).rejects.toThrow();
	expect((await rowState()).agent.isActive).toBe(true);
	expect((await rowState()).approval.status).toBe("expired");
});
it("explicit accidental-issuance IDs retire only named NULL-provenance session without fabricating a signer", async () => {
	const plan = await prepare([lostSessionId]);
	await run(plan);
	const [lost] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, lostSessionId));
	expect(lost.isActive).toBe(false);
	expect(lost.authMethodId).toBeNull();
	expect(await sessionService.getSession(humanSessionId, false)).not.toBeNull();
});
it.each(["stale", "scaling", "task", "target", "probe", "namespace"] as const)(
	"rejects incomplete quiescence: %s",
	async (field) => {
		const plan = await prepare();
		const before = await rowState();
		const receipt = quiescence(plan);
		if (field === "stale")
			receipt.observedAt = new Date(Date.now() - 61_000).toISOString();
		if (field === "scaling")
			receipt.services[0].scaling.DynamicScalingOutSuspended = false;
		if (field === "task") receipt.services[0].stoppedTasks = [];
		if (field === "target") receipt.services[0].drainedTargetGroups = [];
		if (field === "probe") receipt.admissionProbes[0].status = 200;
		if (field === "namespace") receipt.maintenancePlanSha256 = "b".repeat(64);
		expect(() => validateOldIssuerQuiescence(receipt, plan)).toThrow();
		await expect(
			retireOldIssuerAuth(plan, async () => receipt, record),
		).rejects.toThrow();
		expect(await rowState()).toEqual(before);
	},
);

it("a lost-session approval closes its finalized NULL-provenance authorization code by exact ID", async () => {
	const [humanCode] = await getDb()
		.select()
		.from(authCodes)
		.where(eq(authCodes.id, humanCodeId));
	const [lostCode] = await getDb()
		.insert(authCodes)
		.values({ ...humanCode, id: randomUUID(), codeHash: randomUUID() })
		.returning();
	await getDb()
		.insert(authSessions)
		.values({
			sessionToken: randomUUID(),
			applicationId: appId,
			purpose: "oauth_authorization",
			status: "consumed",
			approvedBySessionId: lostSessionId,
			oauthRedirectUri: "https://fixture.invalid/callback",
			oauthCodeChallenge: "fixture-challenge",
			oauthCodeChallengeMethod: "S256",
			oauthScopes: [],
			finalizedAuthCodeId: lostCode.id,
			expiresAt: new Date(Date.now() + 60 * 60_000),
		});
	const plan = await prepare([lostSessionId]);
	expect(
		plan.snapshot.codes.some(
			(r) => r.id === lostCode.id && r.auth_method_id === null,
		),
	).toBe(true);
	await run(plan);
	const [retained] = await getDb()
		.select()
		.from(authCodes)
		.where(eq(authCodes.id, lostCode.id));
	expect(retained.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
	expect(retained.usedAt).toBeNull();
	expect(retained.authMethodId).toBeNull();
	const [ordinary] = await getDb()
		.select()
		.from(authCodes)
		.where(eq(authCodes.id, humanCodeId));
	expect(ordinary.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

it("a concurrent session mutation after durable intent fails canonical CAS instead of confirming retirement", async () => {
	const plan = await prepare();
	await expect(
		run(plan, async (event) => {
			if (event.phase === "session-retirement-intent") {
				await getDb()
					.update(sessions)
					.set({ scopes: ["user:read"] })
					.where(eq(sessions.id, agentRowId));
			}
		}),
	).rejects.toThrow("CAS_MISMATCH");
	expect((await rowState()).agent.isActive).toBe(true);
	expect((await rowState()).approval.status).toBe("expired");
});
