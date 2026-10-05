import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { accountClosureFences } from "../../db/schema/accountClosureFences";
import { applicationCredentials } from "../../db/schema/applicationCredentials";
import { applications } from "../../db/schema/applications";
import { users } from "../../db/schema/users";
import { generateCredentialMaterial } from "../../utils/credentialMaterial";
import { isCredentialUsable } from "../../utils/credentialUsability";
import { MERCARIA_BILLING_SCOPES } from "../mercariaBillingAuthority.service";
import {
	inspectEphemeralCredential as inspect,
	issueEphemeralCredential as issue,
	prepareEphemeralCredential as prepare,
	revokeEphemeralCredential as revoke,
} from "../mercariaEphemeralCredential.service";
const actor = {
	isPlatformStaff: true,
	describedAs: "synthetic operator fixture",
};
const cleanups: Array<() => Promise<void>> = [];
beforeAll(connectPostgres);
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});
afterAll(closePostgres);
async function fixture() {
	const [owner] = await getDb()
		.insert(users)
		.values({ color: "teal" })
		.returning();
	const [app] = await getDb()
		.insert(applications)
		.values({
			name: `ephemeral-${randomUUID()}`,
			ownerAccountId: owner.id,
			type: "first_party",
			status: "active",
			scopes: [...MERCARIA_BILLING_SCOPES],
		})
		.returning();
	const [other] = await getDb()
		.insert(applicationCredentials)
		.values({
			applicationId: app.id,
			name: "production unchanged",
			type: "service",
			environment: "production",
			publicKey: randomUUID(),
			secretHash: "a".repeat(64),
			scopes: ["user:read"],
		})
		.returning();
	return {
		target: { applicationId: app.id, ownerAccountId: owner.id },
		app,
		other,
	};
}
async function row(id: string) {
	const [result] = await getDb()
		.select()
		.from(applicationCredentials)
		.where(eq(applicationCredentials.id, id));
	return result;
}
it("creates one scoped expiring service row with no invented customer actor or unrelated mutation", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, actor);
	expect(await row(plan.credentialId)).toBeUndefined();
	const material = generateCredentialMaterial();
	const receipt = await issue(plan, material, actor);
	const result = await row(plan.credentialId);
	expect(result).toMatchObject({
		type: "service",
		environment: "development",
		scopes: ["payments:read", "payments:write"],
		createdByUserId: null,
		status: "active",
		publicKey: material.publicKey,
		secretHash: material.secretHash,
	});
	expect(result.expiresAt?.toISOString()).toBe(plan.expiresAt);
	expect(Date.parse(plan.expiresAt) - Date.parse(plan.issuedAt)).toBe(3600_000);
	expect(isCredentialUsable(result)).toBe(true);
	expect(JSON.stringify(receipt)).not.toContain(material.secret);
	expect(JSON.stringify(receipt)).not.toContain(material.secretHash);
	expect(await row(f.other.id)).toEqual(f.other);
	const [app] = await getDb()
		.select()
		.from(applications)
		.where(eq(applications.id, f.app.id));
	expect(app).toEqual(f.app);
	await expect(issue(plan, material, actor)).rejects.toThrow();
});
it("two independently prepared issuances serialize to one credential", async () => {
	const f = await fixture();
	const a = await prepare(f.target, actor);
	const b = await prepare(f.target, actor);
	const result = await Promise.allSettled([
		issue(a, generateCredentialMaterial(), actor),
		issue(b, generateCredentialMaterial(), actor),
	]);
	expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
	expect(result.filter((x) => x.status === "rejected")).toHaveLength(1);
});
it("rejects nonoperator, wrong owner, missing ceiling and closure fence", async () => {
	const f = await fixture();
	await expect(
		prepare(f.target, { ...actor, isPlatformStaff: false }),
	).rejects.toThrow("precondition");
	await expect(
		prepare({ ...f.target, ownerAccountId: randomUUID() }, actor),
	).rejects.toThrow("precondition");
	await getDb()
		.update(applications)
		.set({ scopes: ["payments:read"] })
		.where(eq(applications.id, f.app.id));
	await expect(prepare(f.target, actor)).rejects.toThrow("precondition");
	await getDb()
		.update(applications)
		.set({ scopes: [...MERCARIA_BILLING_SCOPES] })
		.where(eq(applications.id, f.app.id));
	await getDb()
		.insert(accountClosureFences)
		.values({ accountId: f.target.ownerAccountId });
	await expect(prepare(f.target, actor)).rejects.toThrow("precondition");
});
it("rechecks closure and application ABA under the issuing transaction", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, actor);
	await getDb()
		.update(applications)
		.set({ name: "changed" })
		.where(eq(applications.id, f.app.id));
	await getDb()
		.update(applications)
		.set({
			name: f.app.name,
			updatedAt: sql`${plan.before.updatedAt}::timestamptz`,
		})
		.where(eq(applications.id, f.app.id));
	await expect(
		issue(plan, generateCredentialMaterial(), actor),
	).rejects.toThrow("precondition");
	const next = await prepare(f.target, actor);
	await getDb()
		.insert(accountClosureFences)
		.values({ accountId: f.target.ownerAccountId });
	await expect(
		issue(next, generateCredentialMaterial(), actor),
	).rejects.toThrow("precondition");
	expect(await row(plan.credentialId)).toBeUndefined();
});
it("rejects lifetime extension, expired intent and incorrect material", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, actor);
	const material = generateCredentialMaterial();
	await expect(
		issue(
			{
				...plan,
				expiresAt: new Date(Date.parse(plan.issuedAt) + 3600_001).toISOString(),
			},
			material,
			actor,
		),
	).rejects.toThrow("precondition");
	await expect(
		issue(
			{
				...plan,
				issuedAt: new Date(Date.now() - 2000).toISOString(),
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			},
			material,
			actor,
		),
	).rejects.toThrow("precondition");
	await expect(
		issue(plan, { ...material, secretHash: "wrong" }, actor),
	).rejects.toThrow("precondition");
});
it("reconciles exact ID after lost acknowledgement; revoke CAS notices mint/ABA and never removes another row", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, actor);
	const material = generateCredentialMaterial();
	await issue(plan, material, actor);
	const old = await inspect(plan, material, actor);
	await getDb()
		.update(applicationCredentials)
		.set({ lastUsedAt: new Date() })
		.where(eq(applicationCredentials.id, plan.credentialId));
	await expect(revoke(plan, material, old.state, actor)).rejects.toThrow(
		"precondition",
	);
	const fresh = await inspect(plan, material, actor);
	await expect(
		inspect(plan, generateCredentialMaterial(), actor),
	).rejects.toThrow("precondition");
	const done = await revoke(plan, material, fresh.state, actor);
	expect(done.state.status).toBe("revoked");
	expect(isCredentialUsable(await row(plan.credentialId))).toBe(false);
	expect(await row(f.other.id)).toEqual(f.other);
	await expect(revoke(plan, material, fresh.state, actor)).rejects.toThrow(
		"precondition",
	);
});
it("allows exact cleanup after a closure fence, without allowing another issue", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, actor);
	const material = generateCredentialMaterial();
	await issue(plan, material, actor);
	await getDb()
		.insert(accountClosureFences)
		.values({ accountId: f.target.ownerAccountId });
	const current = await inspect(plan, material, actor);
	await revoke(plan, material, current.state, actor);
	await expect(prepare(f.target, actor)).rejects.toThrow("precondition");
});

it("rejects archived owners and suspended applications before preparing a credential", async () => {
	const f = await fixture();
	await getDb()
		.update(users)
		.set({ accountStatus: "archived" })
		.where(eq(users.id, f.target.ownerAccountId));
	await expect(prepare(f.target, actor)).rejects.toThrow("precondition");
	await getDb()
		.update(users)
		.set({ accountStatus: "active" })
		.where(eq(users.id, f.target.ownerAccountId));
	await getDb()
		.update(applications)
		.set({ status: "suspended" })
		.where(eq(applications.id, f.target.applicationId));
	await expect(prepare(f.target, actor)).rejects.toThrow("precondition");
});

it("one-shot operation seam accepts only verifier, exact target and closed input; persists no plaintext", async () => {
	const { runEphemeralOperation } = await import(
		"../../operations/mercariaEphemeralCredential"
	);
	const { target } = await import("../mercariaEphemeralCredential.contract");
	const { credentialVerifier } = await import("../../utils/credentialMaterial");
	// The exact target is Oxy's own fixed account and application: remove them
	// afterwards so a later suite in this worker's database can seed them too.
	cleanups.push(async () => {
		await getDb()
			.delete(applicationCredentials)
			.where(eq(applicationCredentials.applicationId, target.applicationId));
		await getDb().delete(applications).where(eq(applications.id, target.applicationId));
		await getDb().delete(users).where(eq(users.id, target.ownerAccountId));
	});
	await getDb()
		.insert(users)
		.values({ id: target.ownerAccountId, color: "teal" });
	await getDb()
		.insert(applications)
		.values({
			id: target.applicationId,
			name: "synthetic exact operator target",
			ownerAccountId: target.ownerAccountId,
			type: "first_party",
			status: "active",
			scopes: [...MERCARIA_BILLING_SCOPES],
		});
	const common = {
		schemaVersion: 1,
		nonce: "a".repeat(32),
		operator: {
			account: "237343248947",
			arn: "arn:aws:iam::237343248947:user/synthetic-fixture",
			receiptSha256: "b".repeat(64),
		},
	};
	const prepared = await runEphemeralOperation({ ...common, mode: "prepare" });
	const plan = prepared.result;
	const material = generateCredentialMaterial();
	const verifier = credentialVerifier(material);
	await expect(
		runEphemeralOperation({
			...common,
			mode: "issue",
			plan,
			verifier: material,
		}),
	).rejects.toThrow();
	const issued = await runEphemeralOperation({
		...common,
		mode: "issue",
		plan,
		verifier,
	});
	expect(JSON.stringify(issued)).not.toContain(material.secret);
	expect(JSON.stringify(issued)).not.toContain(material.secretHash);
	const inspected = await runEphemeralOperation({
		...common,
		mode: "inspect",
		plan,
		verifier,
	});
	if (!("state" in inspected.result))
		throw new Error("Expected inspect receipt");
	const revoked = await runEphemeralOperation({
		...common,
		mode: "revoke",
		plan,
		verifier,
		expected: inspected.result.state,
	});
	if (!("state" in revoked.result)) throw new Error("Expected revoke receipt");
	expect(revoked.result.state.status).toBe("revoked");
});

it("expiry while waiting on the application lock cannot insert a stale credential", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, actor);
	plan.expiresAt = new Date(Date.now() + 200).toISOString();
	let locked!: () => void;
	const ready = new Promise<void>((resolve) => {
		locked = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const holder = getDb().transaction(async (tx) => {
		await tx
			.select({ id: applications.id })
			.from(applications)
			.where(eq(applications.id, f.app.id))
			.for("update");
		locked();
		await gate;
	});
	await ready;
	const attempt = issue(plan, generateCredentialMaterial(), actor);
	const assertion = expect(attempt).rejects.toThrow("precondition");
	try {
		await new Promise((resolve) => setTimeout(resolve, 240));
	} finally {
		release();
	}
	await holder;
	await assertion;
	expect(await row(plan.credentialId)).toBeUndefined();
});
