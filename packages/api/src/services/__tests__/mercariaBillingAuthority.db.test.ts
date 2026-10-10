import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { accountClosureFences } from "../../db/schema/accountClosureFences";
import { applicationCredentials } from "../../db/schema/applicationCredentials";
import { applications } from "../../db/schema/applications";
import { users } from "../../db/schema/users";
import { SEED_APPS } from "../../scripts/seedOxyApplicationsSpecs";
import {
	applyMercariaBillingAuthority as apply,
	prepareMercariaBillingAuthority as prepare,
	rollbackMercariaBillingAuthority as rollback,
	MERCARIA_BILLING_BASE_SCOPES as BASE,
	MERCARIA_BILLING_SCOPES as NEXT,
} from "../mercariaBillingAuthority.service";
const ACTOR = {
	isPlatformStaff: true,
	describedAs: "synthetic local operator",
};
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
	const [owner] = await getDb()
		.insert(users)
		.values({ color: "teal" })
		.returning();
	const [app] = await getDb()
		.insert(applications)
		.values({
			name: `authority-${randomUUID()}`,
			ownerAccountId: owner.id,
			type: "first_party",
			status: "active",
			scopes: [...BASE],
		})
		.returning();
	const [credential] = await getDb()
		.insert(applicationCredentials)
		.values({
			applicationId: app.id,
			name: "owned service fixture",
			type: "service",
			environment: "production",
			status: "active",
			publicKey: randomUUID(),
			secretHash: "a".repeat(64),
			scopes: [...BASE],
		})
		.returning();
	const [other] = await getDb()
		.insert(applicationCredentials)
		.values({
			applicationId: app.id,
			name: "untouched public fixture",
			type: "public",
			environment: "production",
			status: "active",
			publicKey: randomUUID(),
			scopes: ["user:read"],
		})
		.returning();
	return {
		target: {
			applicationId: app.id,
			credentialId: credential.id,
			ownerAccountId: owner.id,
		},
		app,
		credential,
		other,
	};
}
async function rows(f: Awaited<ReturnType<typeof fixture>>) {
	const [app] = await getDb()
		.select()
		.from(applications)
		.where(eq(applications.id, f.app.id));
	const credentials = await getDb()
		.select()
		.from(applicationCredentials)
		.where(eq(applicationCredentials.applicationId, f.app.id));
	return { app, credentials };
}
it("canonical Mercaria ceiling retains billing and the separately approved media import", () => {
	expect(SEED_APPS.find((x) => x.name === "Mercaria")?.scopes).toEqual([...NEXT, "files:user-media:write"]);
});
it("prepare is read-only; apply and exact rollback preserve every unrelated field and credential", async () => {
	const f = await fixture();
	const original = await rows(f);
	const plan = await prepare(f.target, ACTOR);
	expect(await rows(f)).toEqual(original);
	const receipt = await apply(plan, ACTOR);
	const current = await rows(f);
	expect(current.app).toEqual({
		...original.app,
		scopes: NEXT,
		updatedAt: expect.any(Date),
	});
	expect(current.credentials.find((x) => x.id === f.credential.id)).toEqual({
		...f.credential,
		scopes: NEXT,
		updatedAt: expect.any(Date),
	});
	expect(current.credentials.find((x) => x.id === f.other.id)).toEqual(f.other);
	expect(JSON.stringify(receipt)).not.toContain(f.credential.secretHash);
	await rollback(receipt, ACTOR);
	const restored = await rows(f);
	expect(restored.app).toEqual({
		...original.app,
		updatedAt: expect.any(Date),
	});
	expect(restored.credentials.find((x) => x.id === f.credential.id)).toEqual({
		...f.credential,
		updatedAt: expect.any(Date),
	});
	await expect(rollback(receipt, ACTOR)).rejects.toThrow("precondition");
});
it("two concurrent applies linearize once, with no partial second change", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, ACTOR);
	const outcomes = await Promise.allSettled([
		apply(plan, ACTOR),
		apply(plan, ACTOR),
	]);
	expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
	expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
	expect((await rows(f)).app.scopes).toEqual(NEXT);
});
it("ABA with scopes and updatedAt restored still rejects through PostgreSQL row version", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, ACTOR);
	await getDb()
		.update(applications)
		.set({ scopes: ["user:read"] })
		.where(eq(applications.id, f.app.id));
	await getDb()
		.update(applications)
		.set({
			scopes: [...BASE],
			updatedAt: sql`${plan.before.application.updatedAt}::timestamptz`,
		})
		.where(eq(applications.id, f.app.id));
	await expect(apply(plan, ACTOR)).rejects.toThrow("precondition");
	expect(
		(await rows(f)).credentials.find((x) => x.id === f.credential.id)?.scopes,
	).toEqual(BASE);
});
it("rollback refuses a subsequent operator change without overwriting either row", async () => {
	const f = await fixture();
	const receipt = await apply(await prepare(f.target, ACTOR), ACTOR);
	await getDb()
		.update(applicationCredentials)
		.set({ scopes: ["user:read"] })
		.where(eq(applicationCredentials.id, f.credential.id));
	const before = await rows(f);
	await expect(rollback(receipt, ACTOR)).rejects.toThrow("precondition");
	expect(await rows(f)).toEqual(before);
});
it("wrong owner, public credential, nonstaff and closure fence refuse before mutations", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, ACTOR);
	await expect(
		prepare({ ...f.target, ownerAccountId: randomUUID() }, ACTOR),
	).rejects.toThrow("precondition");
	await expect(
		prepare({ ...f.target, credentialId: f.other.id }, ACTOR),
	).rejects.toThrow("precondition");
	await expect(
		apply(plan, { ...ACTOR, isPlatformStaff: false }),
	).rejects.toThrow("precondition");
	await getDb()
		.insert(accountClosureFences)
		.values({ accountId: f.target.ownerAccountId });
	const before = await rows(f);
	await expect(apply(plan, ACTOR)).rejects.toThrow("precondition");
	expect(await rows(f)).toEqual(before);
});
it("revoked credential after preparation refuses and preserves application ceiling", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, ACTOR);
	await getDb()
		.update(applicationCredentials)
		.set({ status: "revoked" })
		.where(eq(applicationCredentials.id, f.credential.id));
	await expect(apply(plan, ACTOR)).rejects.toThrow("precondition");
	expect((await rows(f)).app.scopes).toEqual(BASE);
});
it("constraint failure at second update rolls the first update back", async () => {
	const f = await fixture();
	const plan = await prepare(f.target, ACTOR);
	const constraint = `test_authority_${randomUUID().replaceAll("-", "")}`;
	await getDb().execute(
		sql.raw(
			`ALTER TABLE application_credentials ADD CONSTRAINT ${constraint} CHECK (id <> '${f.credential.id}' OR NOT ('payments:write' = ANY(scopes)))`,
		),
	);
	try {
		await expect(apply(plan, ACTOR)).rejects.toThrow();
		expect((await rows(f)).app).toEqual(f.app);
		expect(
			(await rows(f)).credentials.find((x) => x.id === f.credential.id),
		).toEqual(f.credential);
	} finally {
		await getDb().execute(
			sql.raw(
				`ALTER TABLE application_credentials DROP CONSTRAINT ${constraint}`,
			),
		);
	}
});

it.each(["development", "expires", "inherited", "extra"])(
	"fails closed for unsupported credential state: %s",
	async (mode) => {
		const f = await fixture();
		await getDb()
			.update(applicationCredentials)
			.set(
				mode === "development"
					? { environment: "development" }
					: mode === "expires"
						? { expiresAt: new Date(Date.now() + 60000) }
						: mode === "inherited"
							? { scopes: [] }
							: { scopes: [...BASE, "payments:read"] },
			)
			.where(eq(applicationCredentials.id, f.credential.id));
		const before = await rows(f);
		await expect(prepare(f.target, ACTOR)).rejects.toThrow("precondition");
		expect(await rows(f)).toEqual(before);
	},
);
