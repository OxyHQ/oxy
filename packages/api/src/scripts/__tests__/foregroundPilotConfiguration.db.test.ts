/** Configuration integrity uses real SQL and the canonical workload-attribution writer. No AWS/HTTP dispatch. */
import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { oxyProfileCapabilityCatalog } from "../../capabilities/oxy-profile.catalog";
import { closePostgres, connectPostgres, getDb } from "../../config/postgres";
import { accountClosureFences } from "../../db/schema/accountClosureFences";
import { appCapabilityCatalogRegistrations } from "../../db/schema/agency";
import { applicationCredentialAuditEvents } from "../../db/schema/applicationCredentialAuditEvents";
import { applicationCredentials } from "../../db/schema/applicationCredentials";
import { applicationWorkloadIdentities } from "../../db/schema/applicationWorkloadIdentities";
import { applications } from "../../db/schema/applications";
import { users } from "../../db/schema/users";
import { createTestDatabase, dropTestDatabase } from "../../db/testDatabase";
import { digestCatalog } from "../../services/capabilityCatalog.service";
import { bindWorkloadIdentity } from "../../services/workloadIdentityBinding.service";
import {
	MENTION_BACKEND_ROLE,
	MENTION_MCP_ROLE,
	applyForegroundPilotConfiguration,
	createEphemeralRegistrarCredential,
	prepareForegroundPilotPlan,
	retireEphemeralRegistrarCredentials,
	rollbackForegroundPilotConfiguration,
} from "../foregroundPilotConfiguration";
import { registerForegroundPilotCatalog } from "../foregroundPilotExecutor";
import { ForegroundPilotHttps } from "../foregroundPilotHttps";
import {
	MENTION_APPLICATION_ID,
	OXY_PROFILE_REGISTRAR_APPLICATION_ID,
} from "../seedOxyApplicationsSpecs";

const originalDatabaseUrl = process.env.DATABASE_URL;
let ownDatabaseUrl: string | undefined;
jest.setTimeout(60_000);
beforeAll(async () => {
	// The registrar's absence is a global production precondition. Keep that
	// inventory intact while isolating this suite from other catalog fixtures.
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
// These fixed application IDs mirror the reviewed plan; every case owns its rows.
beforeEach(async () => {
	await getDb()
		.delete(applications)
		.where(
			inArray(applications.id, [
				MENTION_APPLICATION_ID,
				OXY_PROFILE_REGISTRAR_APPLICATION_ID,
			]),
		);
	await getDb().delete(users).where(eq(users.username, "oxy"));
});
const originalScopes = [
	"user:read",
	"catalogs:write",
	"capabilities:read",
	"capability-audit:write",
];
function table(rows: unknown[]) {
	return { status: "complete", count: rows.length, rows };
}
async function snapshots(ownerId: string) {
	const expectedApplication = await getDb()
		.select({
			id: applications.id,
			type: applications.type,
			status: applications.status,
			is_official: applications.isOfficial,
			is_internal: applications.isInternal,
			owner_account_id: applications.ownerAccountId,
			scopes: applications.scopes,
			capabilities: applications.capabilities,
			row_revision: sql<string>`xmin::text`,
		})
		.from(applications)
		.where(eq(applications.id, MENTION_APPLICATION_ID));
	const bindings = await getDb()
		.select({
			id: applicationWorkloadIdentities.id,
			application_id: applicationWorkloadIdentities.applicationId,
			provider: applicationWorkloadIdentities.provider,
			subject: applicationWorkloadIdentities.subject,
			scopes: applicationWorkloadIdentities.scopes,
			expires_at: applicationWorkloadIdentities.expiresAt,
			row_revision: sql<string>`xmin::text`,
		})
		.from(applicationWorkloadIdentities)
		.where(
			eq(applicationWorkloadIdentities.applicationId, MENTION_APPLICATION_ID),
		);
	const credentials = await getDb()
		.select({
			id: applicationCredentials.id,
			application_id: applicationCredentials.applicationId,
			type: applicationCredentials.type,
			environment: applicationCredentials.environment,
			status: applicationCredentials.status,
			expires_at: applicationCredentials.expiresAt,
			scopes: applicationCredentials.scopes,
			workload_identity_id: applicationCredentials.workloadIdentityId,
			row_revision: sql<string>`xmin::text`,
		})
		.from(applicationCredentials)
		.where(eq(applicationCredentials.applicationId, MENTION_APPLICATION_ID));
	const owners = await getDb()
		.select({
			id: users.id,
			account_status: users.accountStatus,
			row_revision: sql<string>`xmin::text`,
		})
		.from(users)
		.where(eq(users.id, ownerId));
	const roots = await getDb()
		.select({
			id: users.id,
			account_status: users.accountStatus,
			kind: users.kind,
			row_revision: sql<string>`xmin::text`,
			is_platform_root: sql<boolean>`COALESCE(${users.username} = 'oxy', false)`,
		})
		.from(users)
		.where(eq(users.id, ownerId));
	const common = {
		schemaVersion: 1,
		profile: "oxy",
		readOnly: true,
		isolation: "repeatable read",
		observedAt: new Date().toISOString(),
		runtime: {
			node: process.version,
			postgresVersion: "synthetic-metadata",
			postgresEntrySha256: "0".repeat(64),
		},
	};
	return {
		mention: {
			...common,
			kind: "mention-foreground-preflight",
			selectedMentionApplicationId: MENTION_APPLICATION_ID,
			tables: {
				applications: table(expectedApplication),
				application_workload_identities: table(bindings),
				application_credentials: table(credentials),
				users: table(owners),
				account_closure_fences: table([]),
				app_capability_catalog_registrations: table([]),
			},
		},
		registrar: {
			...common,
			kind: "oxy-profile-registrar-preflight",
			proposedRegistrarApplicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
			tables: {
				applications: table([]),
				application_workload_identities: table([]),
				application_credentials: table([]),
				users: table(roots),
				account_closure_fences: table([]),
				app_capability_catalog_registrations: table([]),
			},
		},
	};
}

it("applies only the reviewed delta, rejects drift/fences, rolls back partial SQL, and retains audited ephemeral history", async () => {
	const [owner] = await getDb()
		.insert(users)
		.values({ username: "oxy", kind: "organization" })
		.returning();
	await getDb()
		.insert(applications)
		.values({
			id: MENTION_APPLICATION_ID,
			name: "Synthetic Mention",
			ownerAccountId: owner.id,
			type: "first_party",
			status: "active",
			isOfficial: true,
			isInternal: false,
			scopes: originalScopes,
			capabilities: ["catalog:mention"],
		});
	const previousNodeEnv = process.env.NODE_ENV;
	try {
		// Exercise the real attribution writer's production namespace on this owned fixture DB.
		process.env.NODE_ENV = "production";
		for (const subject of [MENTION_BACKEND_ROLE, MENTION_MCP_ROLE]) {
			await bindWorkloadIdentity({
				applicationId: MENTION_APPLICATION_ID,
				provider: "aws-iam",
				subject,
				scopes: originalScopes,
				actor: {
					isPlatformStaff: true,
					describedAs: "synthetic configuration fixture",
				},
			});
		}
	} finally {
		if (previousNodeEnv === undefined)
			Reflect.deleteProperty(process.env, "NODE_ENV");
		else process.env.NODE_ENV = previousNodeEnv;
	}
	const fresh = async () => {
		const input = await snapshots(owner.id);
		return prepareForegroundPilotPlan(input.mention, input.registrar);
	};
	const absentRegistrar = async () =>
		expect(
			await getDb()
				.select({ id: applications.id })
				.from(applications)
				.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID)),
		).toEqual([]);
	let plan = await fresh();
	await getDb()
		.update(applications)
		.set({ status: "suspended" })
		.where(eq(applications.id, MENTION_APPLICATION_ID));
	await expect(applyForegroundPilotConfiguration(plan)).rejects.toThrow(
		"application changed",
	);
	await absentRegistrar();
	await getDb()
		.update(applications)
		.set({ status: "active" })
		.where(eq(applications.id, MENTION_APPLICATION_ID));
	plan = await fresh();
	await getDb().insert(accountClosureFences).values({ accountId: owner.id });
	await expect(applyForegroundPilotConfiguration(plan)).rejects.toThrow(
		"owner fenced",
	);
	await absentRegistrar();
	await getDb()
		.delete(accountClosureFences)
		.where(eq(accountClosureFences.accountId, owner.id));
	plan = await fresh();
	const mcp = plan.expectedWorkloads.find(
		(binding) => binding.subject === MENTION_MCP_ROLE,
	);
	if (!mcp) throw new Error("MCP fixture absent");
	await getDb()
		.update(applicationWorkloadIdentities)
		.set({ scopes: [...originalScopes, "files:read"] })
		.where(eq(applicationWorkloadIdentities.id, mcp.id));
	await expect(applyForegroundPilotConfiguration(plan)).rejects.toThrow(
		"workload binding changed",
	);
	await absentRegistrar();
	await getDb()
		.update(applicationWorkloadIdentities)
		.set({ scopes: originalScopes })
		.where(eq(applicationWorkloadIdentities.id, mcp.id));
	plan = await fresh();
	const identity = plan.expectedCredentials[0];
	if (!identity) throw new Error("Canonical identity fixture absent");
	await getDb()
		.update(applicationCredentials)
		.set({ status: "revoked" })
		.where(eq(applicationCredentials.id, identity.id));
	await expect(applyForegroundPilotConfiguration(plan)).rejects.toThrow(
		"canonical attribution identity changed",
	);
	await absentRegistrar();
	await getDb()
		.update(applicationCredentials)
		.set({ status: "active" })
		.where(eq(applicationCredentials.id, identity.id));
	plan = await fresh();
	await getDb().execute(
		sql`CREATE FUNCTION i05_test_fail_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic second-write failure'; END $$`,
	);
	await getDb().execute(
		sql`CREATE TRIGGER i05_test_binding_failure BEFORE UPDATE ON application_workload_identities FOR EACH ROW EXECUTE FUNCTION i05_test_fail_binding()`,
	);
	try {
		await expect(applyForegroundPilotConfiguration(plan)).rejects.toThrow();
	} finally {
		await getDb().execute(
			sql`DROP TRIGGER i05_test_binding_failure ON application_workload_identities`,
		);
		await getDb().execute(sql`DROP FUNCTION i05_test_fail_binding()`);
	}
	await absentRegistrar();
	const [unchanged] = await getDb()
		.select({
			scopes: applications.scopes,
			capabilities: applications.capabilities,
		})
		.from(applications)
		.where(eq(applications.id, MENTION_APPLICATION_ID));
	expect(unchanged).toEqual({
		scopes: originalScopes,
		capabilities: ["catalog:mention"],
	});
	// The failed transaction also leaves the old revisions valid for the same CAS.
	await applyForegroundPilotConfiguration(plan);
	const [machine] = await getDb()
		.select()
		.from(applications)
		.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID));
	expect(machine).toMatchObject({
		type: "internal",
		isInternal: true,
		ownerAccountId: owner.id,
		scopes: ["catalogs:write"],
		capabilities: ["catalog:oxy"],
		redirectUris: [],
	});
	expect(
		await getDb()
			.select()
			.from(applicationCredentials)
			.where(eq(applicationCredentials.applicationId, machine.id)),
	).toEqual([]);
	const [changed] = await getDb()
		.select({
			scopes: applications.scopes,
			capabilities: applications.capabilities,
		})
		.from(applications)
		.where(eq(applications.id, MENTION_APPLICATION_ID));
	expect(changed).toEqual({
		scopes: [...originalScopes, "capability-tickets:issue"],
		capabilities: ["catalog:mention", "agency:coordinate"],
	});
	const after = await snapshots(owner.id);
	const expectedMcp = plan.expectedWorkloads.find(
		(binding) => binding.subject === MENTION_MCP_ROLE,
	);
	expect(
		after.mention.tables.application_workload_identities.rows.find(
			(binding) => binding.subject === MENTION_MCP_ROLE,
		),
	).toEqual(expectedMcp);
	expect(
		after.mention.tables.application_credentials.rows.sort((a, b) =>
			a.id < b.id ? -1 : 1,
		),
	).toEqual(plan.expectedCredentials);

	const beforeCredentialPlan = {
		...plan,
		nonce: randomBytes(16).toString("hex"),
	};
	const beforeCredentialAbort = new AbortController();
	beforeCredentialAbort.abort();
	const forbiddenNetwork = jest.fn<
		ReturnType<typeof fetch>,
		Parameters<typeof fetch>
	>();
	await expect(
		registerForegroundPilotCatalog(
			beforeCredentialPlan,
			async () => {},
			beforeCredentialAbort.signal,
			new ForegroundPilotHttps(forbiddenNetwork),
		),
	).rejects.toThrow("cancelled");
	expect(
		await getDb()
			.select({ id: applicationCredentials.id })
			.from(applicationCredentials)
			.where(
				eq(
					applicationCredentials.name,
					`I05 ephemeral registrar ${beforeCredentialPlan.nonce}`,
				),
			),
	).toEqual([]);
	expect(forbiddenNetwork).not.toHaveBeenCalled();
	const cancelledPlan = { ...plan, nonce: randomBytes(16).toString("hex") };
	const abort = new AbortController();
	const phases: string[] = [];
	const failedAck = jest
		.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
		.mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new Error("synthetic unknown ACK")),
						{ once: true },
					);
					abort.abort();
				}),
		);
	await expect(
		registerForegroundPilotCatalog(
			cancelledPlan,
			async (phase) => {
				phases.push(phase);
			},
			abort.signal,
			new ForegroundPilotHttps(failedAck),
		),
	).rejects.toThrow("reconcile persisted intent");
	expect(phases).toEqual([
		"credential-intent",
		"credential-confirmed",
		"mint-intent",
	]);
	const [cancelledCredential] = await getDb()
		.select()
		.from(applicationCredentials)
		.where(
			eq(
				applicationCredentials.name,
				`I05 ephemeral registrar ${cancelledPlan.nonce}`,
			),
		);
	expect(cancelledCredential.status).toBe("revoked");
	expect(failedAck).toHaveBeenCalledTimes(1); // no hidden network retry after unknown ACK.
	const ephemeral = await createEphemeralRegistrarCredential(plan);
	try {
		const [persisted] = await getDb()
			.select()
			.from(applicationCredentials)
			.where(eq(applicationCredentials.id, ephemeral.id));
		expect(persisted.scopes).toEqual(["catalogs:write"]);
		expect(JSON.stringify(persisted)).not.toContain(ephemeral.secret);
		await expect(createEphemeralRegistrarCredential(plan)).rejects.toThrow(
			"intent already exists",
		);
		await getDb().insert(accountClosureFences).values({ accountId: owner.id });
	} finally {
		await retireEphemeralRegistrarCredentials(plan);
	}
	const [retained] = await getDb()
		.select()
		.from(applicationCredentials)
		.where(eq(applicationCredentials.id, ephemeral.id));
	expect(retained.status).toBe("revoked");
	const events = await getDb()
		.select({ event: applicationCredentialAuditEvents.eventType })
		.from(applicationCredentialAuditEvents)
		.where(eq(applicationCredentialAuditEvents.credentialId, ephemeral.id));
	expect(events.map((row) => row.event).sort()).toEqual(["created", "revoked"]);
	await retireEphemeralRegistrarCredentials(plan);
	expect(
		await getDb()
			.select({ event: applicationCredentialAuditEvents.eventType })
			.from(applicationCredentialAuditEvents)
			.where(eq(applicationCredentialAuditEvents.credentialId, ephemeral.id)),
	).toHaveLength(2);
	// SQL fixture of the canonical bytes: real mint/register/retirement is covered by
	// foregroundCapabilities.db.test.ts, not claimed from this synthetic signature.
	const catalog = oxyProfileCapabilityCatalog();
	const [registration] = await getDb()
		.insert(appCapabilityCatalogRegistrations)
		.values({
			appSlug: "oxy",
			version: catalog.version,
			audience: catalog.audience,
			catalog,
			digest: "0".repeat(64),
			signature: "synthetic-configuration-only",
			registeredByApplicationId: machine.id,
			registeredByCredentialId: ephemeral.id,
			deployedAt: new Date(),
		})
		.returning();
	await expect(rollbackForegroundPilotConfiguration(plan)).rejects.toThrow(
		"rollback catalogue pin changed",
	);
	expect(
		(
			await getDb()
				.select({ scopes: applications.scopes })
				.from(applications)
				.where(eq(applications.id, MENTION_APPLICATION_ID))
		)[0].scopes,
	).toEqual(plan.afterScopes);
	await getDb()
		.update(appCapabilityCatalogRegistrations)
		.set({ digest: digestCatalog(catalog) })
		.where(eq(appCapabilityCatalogRegistrations.id, registration.id));
	await rollbackForegroundPilotConfiguration(plan);
	await rollbackForegroundPilotConfiguration(plan); // maintenance retry, without erasing history.
	expect(
		(
			await getDb()
				.select({
					scopes: applications.scopes,
					capabilities: applications.capabilities,
				})
				.from(applications)
				.where(eq(applications.id, MENTION_APPLICATION_ID))
		)[0],
	).toEqual({ scopes: originalScopes, capabilities: ["catalog:mention"] });
	expect(
		(
			await getDb()
				.select({ status: applications.status })
				.from(applications)
				.where(eq(applications.id, machine.id))
		)[0].status,
	).toBe("suspended");
	expect(
		(
			await getDb()
				.select({ active: appCapabilityCatalogRegistrations.active })
				.from(appCapabilityCatalogRegistrations)
				.where(eq(appCapabilityCatalogRegistrations.id, registration.id))
		)[0].active,
	).toBe(false);
	expect(
		(
			await snapshots(owner.id)
		).mention.tables.application_credentials.rows.sort((a, b) =>
			a.id < b.id ? -1 : 1,
		),
	).toEqual(plan.expectedCredentials);
});

async function baselineFixture(
	backendAlreadyHasScope: boolean,
	applicationAlreadyHasGrants: boolean,
) {
	const [owner] = await getDb()
		.insert(users)
		.values({ username: "oxy", kind: "organization" })
		.returning();
	await getDb()
		.insert(applications)
		.values({
			id: MENTION_APPLICATION_ID,
			name: "Synthetic baseline Mention",
			ownerAccountId: owner.id,
			type: "first_party",
			status: "active",
			isOfficial: true,
			isInternal: false,
			scopes: applicationAlreadyHasGrants
				? [...originalScopes, "capability-tickets:issue"]
				: originalScopes,
			capabilities: applicationAlreadyHasGrants
				? ["catalog:mention", "agency:coordinate"]
				: ["catalog:mention"],
		});
	const prior = process.env.NODE_ENV;
	try {
		process.env.NODE_ENV = "production";
		for (const subject of [MENTION_BACKEND_ROLE, MENTION_MCP_ROLE])
			await bindWorkloadIdentity({
				applicationId: MENTION_APPLICATION_ID,
				provider: "aws-iam",
				subject,
				scopes:
					subject === MENTION_BACKEND_ROLE && backendAlreadyHasScope
						? [...originalScopes, "capability-tickets:issue"]
						: originalScopes,
				actor: {
					isPlatformStaff: true,
					describedAs: "synthetic baseline fixture",
				},
			});
	} finally {
		if (prior === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
		else process.env.NODE_ENV = prior;
	}
	const input = await snapshots(owner.id);
	return prepareForegroundPilotPlan(input.mention, input.registrar);
}

it("rejects a new service credential in the complete census before any authority write", async () => {
	const plan = await baselineFixture(false, false);
	await getDb()
		.insert(applicationCredentials)
		.values({
			applicationId: MENTION_APPLICATION_ID,
			name: "Synthetic explicit-scope service",
			type: "service",
			environment: "production",
			status: "active",
			publicKey: "oxy_dk_synthetic_census",
			secretHash: "0".repeat(64),
			scopes: ["capability-tickets:issue"],
		});
	const before = await snapshots(plan.expectedApplication.owner_account_id);
	await expect(applyForegroundPilotConfiguration(plan)).rejects.toThrow(
		"canonical attribution identity changed",
	);
	expect(
		(await snapshots(plan.expectedApplication.owner_account_id)).mention.tables,
	).toEqual(before.mention.tables);
	expect(
		await getDb()
			.select({ id: applications.id })
			.from(applications)
			.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID)),
	).toEqual([]);
});

it.each([false, true])(
	"restores a baseline with preexisting application grants and backend scope present=%s",
	async (backendAlreadyHasScope) => {
		const plan = await baselineFixture(backendAlreadyHasScope, true);
		await applyForegroundPilotConfiguration(plan);
		const credential = await createEphemeralRegistrarCredential(plan);
		await retireEphemeralRegistrarCredentials(plan);
		await expect(rollbackForegroundPilotConfiguration(plan)).resolves.toEqual({
			restoredMention: true,
			registrarRetainedSuspended: true,
		});
		const restored = await snapshots(plan.expectedApplication.owner_account_id);
		expect(
			restored.mention.tables.applications.rows.map(
				({ row_revision: _revision, ...row }) => row,
			),
		).toEqual([
			(({ row_revision: _revision, ...row }) => row)(plan.expectedApplication),
		]);
		expect(
			restored.mention.tables.application_workload_identities.rows
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.map(({ row_revision: _revision, ...row }) => row),
		).toEqual(
			plan.expectedWorkloads.map(({ row_revision: _revision, ...row }) => row),
		);
		expect(
			(
				await getDb()
					.select({ status: applications.status })
					.from(applications)
					.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID))
			)[0].status,
		).toBe("suspended");
		expect(
			(
				await getDb()
					.select({ status: applicationCredentials.status })
					.from(applicationCredentials)
					.where(eq(applicationCredentials.id, credential.id))
			)[0].status,
		).toBe("revoked");
		await rollbackForegroundPilotConfiguration(plan);
		expect(
			(await snapshots(plan.expectedApplication.owner_account_id)).mention
				.tables,
		).toEqual(restored.mention.tables);
	},
);

it("refreshes only activity xmin under the application lock while preserving reviewed authority", async () => {
	const plan = await baselineFixture(false, false);
	await getDb()
		.update(applications)
		.set({ updatedAt: new Date() })
		.where(eq(applications.id, MENTION_APPLICATION_ID));
	const before = await snapshots(plan.expectedApplication.owner_account_id);
	expect(before.mention.tables.applications.rows[0].row_revision).not.toBe(
		plan.expectedApplication.row_revision,
	);
	await applyForegroundPilotConfiguration(plan);
	const applied = await snapshots(plan.expectedApplication.owner_account_id);
	expect(applied.mention.tables.applications.rows[0].scopes).toEqual(
		plan.afterScopes,
	);
	expect(applied.mention.tables.applications.rows[0].capabilities).toEqual(
		plan.afterCapabilities,
	);
	await rollbackForegroundPilotConfiguration(plan);
});
