import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { accountClosureFences } from "../../db/schema/accountClosureFences";
import { appGrants } from "../../db/schema/appGrants";
import { applicationCredentialAuditEvents } from "../../db/schema/applicationCredentialAuditEvents";
import { applicationCredentials } from "../../db/schema/applicationCredentials";
import { applications } from "../../db/schema/applications";
import { users } from "../../db/schema/users";
import { generateCredentialMaterial } from "../../utils/credentialMaterial";
import {
	I03_CANARY_OWNER_ID,
	inspectAliaRevocationCanary as inspect,
	issueAliaRevocationCanary as issue,
	prepareAliaRevocationCanary as prepare,
	retireAliaCanaryAfterTaskFailure as recover,
	revokeAliaRevocationCanary as revoke,
	verifyAliaCanaryAuthorityUnchanged as unchanged,
} from "../aliaRevocationCanary.service";
import {
	I03_CANARY_APPLICATION_ID,
	I03_CANARY_SCOPES,
	revokeApplicationCredential,
} from "../applicationCredentialRevocation.service";
import {
	resolveServiceActingAsGrant,
	revokeServiceActingAs,
} from "../serviceActingAs.service";

// Explicitly synthetic AWS/session attribution, never a live operator approval.
const actor = {
	operatorArn: "arn:aws:sts::237343248947:assumed-role/Fixture/fixture",
	authorizationSha256: "a".repeat(64),
};
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
	// Every field the canary's precondition reads is SET here rather than left
	// to whichever file ran before in this worker's database: the owner id is
	// the real `oxy` organization, which other fixtures (the official-app seed
	// tests) create and delete with their own shape, and a row this fixture
	// merely tolerated failed the precondition whenever sharding put them
	// first.
	await getDb()
		.insert(users)
		.values({ id: I03_CANARY_OWNER_ID, color: "blue" })
		.onConflictDoUpdate({ target: users.id, set: { accountStatus: "active" } });
	await getDb()
		.insert(applications)
		.values({
			id: I03_CANARY_APPLICATION_ID,
			ownerAccountId: I03_CANARY_OWNER_ID,
			name: "Alia canary fixture",
			type: "first_party",
			status: "active",
			scopes: [...I03_CANARY_SCOPES],
		})
		.onConflictDoUpdate({
			target: applications.id,
			set: {
				ownerAccountId: I03_CANARY_OWNER_ID,
				type: "first_party",
				status: "active",
				scopes: [...I03_CANARY_SCOPES],
			},
		});
	const [principal] = await getDb()
		.insert(users)
		.values({ color: "teal" })
		.returning();
	const [grant] = await getDb()
		.insert(appGrants)
		.values({
			userId: principal.id,
			applicationId: I03_CANARY_APPLICATION_ID,
			scopes: [...I03_CANARY_SCOPES],
		})
		.returning();
	const material = generateCredentialMaterial();
	const [other] = await getDb()
		.insert(applicationCredentials)
		.values({
			applicationId: I03_CANARY_APPLICATION_ID,
			name: randomUUID(),
			type: "service",
			environment: "production",
			publicKey: material.publicKey,
			secretHash: material.secretHash,
			scopes: [...I03_CANARY_SCOPES],
		})
		.returning();
	return { principal, grant, other };
}
async function row(id: string) {
	const [r] = await getDb()
		.select()
		.from(applicationCredentials)
		.where(eq(applicationCredentials.id, id));
	return r;
}
async function events(id: string) {
	return getDb()
		.select()
		.from(applicationCredentialAuditEvents)
		.where(eq(applicationCredentialAuditEvents.credentialId, id))
		.orderBy(applicationCredentialAuditEvents.createdAt);
}
it("issues a distinct expiring key with existing grant and explicit operator audit, then canonical revoke denies without changing another key or grant", async () => {
	const f = await fixture();
	const plan = await prepare(f.principal.id, actor);
	const material = generateCredentialMaterial();
	expect(Date.parse(plan.expiresAt) - Date.parse(plan.issuedAt)).toBe(3600_000);
	const issued = await issue(plan, material, actor);
	expect(JSON.stringify(issued)).not.toContain(material.secret);
	expect(JSON.stringify(issued)).not.toContain(material.secretHash);
	const context = {
		credentialId: plan.credentialId,
		ownerAccountId: I03_CANARY_OWNER_ID,
		environment: "production" as const,
	};
	expect(
		(
			await resolveServiceActingAsGrant(
				plan.applicationId,
				plan.principalId,
				context,
			)
		).authorized,
	).toBe(true);
	await revoke(plan, material, actor);
	expect(
		(
			await resolveServiceActingAsGrant(
				plan.applicationId,
				plan.principalId,
				context,
			)
		).authorized,
	).toBe(false);
	expect((await row(plan.credentialId)).status).toBe("revoked");
	expect(await inspect(plan, material, actor)).toEqual({
		exists: true,
		status: "revoked",
	});
	expect(await unchanged(plan, actor)).toBe(true);
	expect(await row(f.other.id)).toEqual(f.other);
	expect(
		await getDb().select().from(appGrants).where(eq(appGrants.id, f.grant.id)),
	).toEqual([f.grant]);
	expect(
		(await events(plan.credentialId)).map((x) => [
			x.eventType,
			x.actorUserId,
			x.metadata,
		]),
	).toEqual([
		[
			"created",
			null,
			{
				type: "service",
				actorKind: "operational_canary",
				...actor,
				nonce: plan.nonce,
			},
		],
		[
			"revoked",
			null,
			{
				type: "service",
				actorKind: "operational_canary",
				...actor,
				nonce: plan.nonce,
			},
		],
	]);
});
it("two plans from one baseline cannot issue two keys", async () => {
	const f = await fixture();
	const a = await prepare(f.principal.id, actor);
	const b = await prepare(f.principal.id, actor);
	const results = await Promise.allSettled([
		issue(a, generateCredentialMaterial(), actor),
		issue(b, generateCredentialMaterial(), actor),
	]);
	expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
	expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
});
it("rejects unknown operator, missing consent and withdrawn consent", async () => {
	const f = await fixture();
	await expect(
		prepare(f.principal.id, { ...actor, operatorArn: "customer" }),
	).rejects.toThrow("precondition");
	await expect(prepare(randomUUID(), actor)).rejects.toThrow("precondition");
	const plan = await prepare(f.principal.id, actor);
	await revokeServiceActingAs(f.principal.id, I03_CANARY_APPLICATION_ID);
	await expect(
		issue(plan, generateCredentialMaterial(), actor),
	).rejects.toThrow("precondition");
	expect(await row(plan.credentialId)).toBeUndefined();
});
it("rejects stale app ceilings and closure before new writes", async () => {
	const f = await fixture();
	const plan = await prepare(f.principal.id, actor);
	await getDb()
		.update(applications)
		.set({ scopes: ["inference:invoke"] })
		.where(eq(applications.id, I03_CANARY_APPLICATION_ID));
	await expect(
		issue(plan, generateCredentialMaterial(), actor),
	).rejects.toThrow("precondition");
	expect(await row(plan.credentialId)).toBeUndefined();
	await getDb()
		.update(applications)
		.set({ scopes: [...I03_CANARY_SCOPES] })
		.where(eq(applications.id, I03_CANARY_APPLICATION_ID));
	await getDb()
		.insert(accountClosureFences)
		.values({ accountId: f.principal.id });
	await expect(prepare(f.principal.id, actor)).rejects.toThrow("precondition");
});
it("rejects wrong app, expired plan and wrong material without issuing", async () => {
	const f = await fixture();
	const plan = await prepare(f.principal.id, actor);
	const material = generateCredentialMaterial();
	await expect(
		issue(
			{ ...plan, applicationId: "other" as typeof plan.applicationId },
			material,
			actor,
		),
	).rejects.toThrow("precondition");
	const old = {
		...plan,
		issuedAt: new Date(Date.now() - 7200_000).toISOString(),
		expiresAt: new Date(Date.now() - 3600_000).toISOString(),
	};
	await expect(issue(old, material, actor)).rejects.toThrow("precondition");
	await expect(
		issue(plan, { ...material, publicKey: "bad" }, actor),
	).rejects.toThrow("precondition");
	expect(await row(plan.credentialId)).toBeUndefined();
});
it("cleanup rejects another key and still works after app withdrawal and expiry", async () => {
	const f = await fixture();
	const plan = await prepare(f.principal.id, actor);
	const material = generateCredentialMaterial();
	await issue(plan, material, actor);
	await expect(
		revoke({ ...plan, credentialId: f.other.id }, material, actor),
	).rejects.toThrow("not found");
	await expect(
		revoke(plan, { ...material, secretHash: "b".repeat(64) }, actor),
	).rejects.toThrow("not found");
	await getDb()
		.update(applications)
		.set({ status: "suspended" })
		.where(eq(applications.id, I03_CANARY_APPLICATION_ID));
	const clock = jest
		.spyOn(Date, "now")
		.mockReturnValue(Date.parse(plan.expiresAt) + 1);
	try {
		await revoke(plan, material, actor);
	} finally {
		clock.mockRestore();
	}
	expect((await row(plan.credentialId)).status).toBe("revoked");
	expect(await row(f.other.id)).toEqual(f.other);
});
it("the shared customer path preserves member actor and its original audit shape", async () => {
	const f = await fixture();
	await revokeApplicationCredential(I03_CANARY_APPLICATION_ID, f.other.id, {
		kind: "customer",
		userId: f.principal.id,
	});
	expect(await events(f.other.id)).toMatchObject([
		{
			eventType: "revoked",
			actorUserId: f.principal.id,
			metadata: { type: "service" },
		},
	]);
});

it("issuance and shared revocation roll back if the operational audit cannot commit", async () => {
	const f = await fixture();
	const plan = await prepare(f.principal.id, actor);
	const material = generateCredentialMaterial();
	const db = getDb();
	await db.execute(
		sql`CREATE FUNCTION i03_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_audit_failure'; END $$`,
	);
	await db.execute(
		sql`CREATE TRIGGER i03_fixture_audit_failure BEFORE INSERT ON application_credential_audit_events FOR EACH ROW EXECUTE FUNCTION i03_fixture_audit_failure()`,
	);
	try {
		await expect(issue(plan, material, actor)).rejects.toThrow();
		expect(await row(plan.credentialId)).toBeUndefined();
		expect(await events(plan.credentialId)).toEqual([]);
	} finally {
		await db.execute(
			sql`DROP TRIGGER i03_fixture_audit_failure ON application_credential_audit_events`,
		);
	}
	await issue(plan, material, actor);
	await db.execute(
		sql`CREATE TRIGGER i03_fixture_audit_failure BEFORE INSERT ON application_credential_audit_events FOR EACH ROW EXECUTE FUNCTION i03_fixture_audit_failure()`,
	);
	try {
		await expect(revoke(plan, material, actor)).rejects.toThrow();
		expect((await row(plan.credentialId)).status).toBe("active");
		expect((await events(plan.credentialId)).map((x) => x.eventType)).toEqual([
			"created",
		]);
		expect(await row(f.other.id)).toEqual(f.other);
	} finally {
		await db.execute(
			sql`DROP TRIGGER i03_fixture_audit_failure ON application_credential_audit_events`,
		);
		await db.execute(sql`DROP FUNCTION i03_fixture_audit_failure()`);
	}
	await revoke(plan, material, actor);
	expect((await row(plan.credentialId)).status).toBe("revoked");
});

it("recovers a task-failure credential by durable intent and immutable audit without retaining its material", async () => {
	const f = await fixture();
	const plan = await prepare(f.principal.id, actor);
	await issue(plan, generateCredentialMaterial(), actor);
	expect(await recover(plan, actor)).toEqual({
		credentialId: plan.credentialId,
		exists: true,
		retired: true,
	});
	expect(await recover(plan, actor)).toEqual({
		credentialId: plan.credentialId,
		exists: true,
		retired: true,
	});
	expect((await events(plan.credentialId)).map((row) => row.eventType)).toEqual(
		["created", "revoked"],
	);
	expect(await row(f.other.id)).toEqual(f.other);
	await expect(
		recover({ ...plan, credentialId: f.other.id }, actor),
	).rejects.toThrow("precondition");
	await expect(
		recover({ ...plan, nonce: "b".repeat(24) }, actor),
	).rejects.toThrow("precondition");
	await expect(
		recover(plan, { ...actor, authorizationSha256: "b".repeat(64) }),
	).rejects.toThrow("precondition");
});

it("allows canonical mint activity metadata but detects a changed app authority after use", async () => {
	const f = await fixture();
	const plan = await prepare(f.principal.id, actor);
	const material = generateCredentialMaterial();
	await issue(plan, material, actor);
	await getDb()
		.update(applications)
		.set({ lastUsedAt: new Date() })
		.where(eq(applications.id, I03_CANARY_APPLICATION_ID));
	expect(await unchanged(plan, actor)).toBe(true);
	await getDb()
		.update(applications)
		.set({ scopes: ["inference:invoke"] })
		.where(eq(applications.id, I03_CANARY_APPLICATION_ID));
	await expect(unchanged(plan, actor)).rejects.toThrow("precondition");
	await recover(plan, actor);
	expect((await row(plan.credentialId)).status).toBe("revoked");
});
