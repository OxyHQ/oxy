/** Exact administrative I05 configuration. No user consent or offline authority is created. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalCapabilityJson } from "@oxy.so/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { oxyProfileCapabilityCatalog } from "../capabilities/oxy-profile.catalog";
import { getDb } from "../config/postgres";
import { accountClosureFences } from "../db/schema/accountClosureFences";
import { appCapabilityCatalogRegistrations } from "../db/schema/agency";
import { applicationCredentials } from "../db/schema/applicationCredentials";
import { applicationWorkloadIdentities } from "../db/schema/applicationWorkloadIdentities";
import { applications } from "../db/schema/applications";
import { users } from "../db/schema/users";
import { recordCredentialLifecycleEvent } from "../services/applicationCredentialAudit.service";
import { digestCatalog } from "../services/capabilityCatalog.service";
import { computeSeedApplicationPlan } from "./seedOxyApplicationsPlan";
import {
	MENTION_APPLICATION_ID,
	OXY_PROFILE_REGISTRAR_APPLICATION_ID,
	OXY_PROFILE_REGISTRAR_SPEC,
} from "./seedOxyApplicationsSpecs";

export const MENTION_BACKEND_ROLE =
	"arn:aws:iam::237343248947:role/oxy-mention-task";
export const MENTION_MCP_ROLE =
	"arn:aws:iam::237343248947:role/oxy-mention-mcp-task";
const TICKET_SCOPE = "capability-tickets:issue";
const COORDINATE = "agency:coordinate";
const revision = z.string().regex(/^\d+$/);
const strings = z
	.array(z.string().min(1))
	.refine((values) => new Set(values).size === values.length);
const account = z.object({
	id: z.string().min(1),
	account_status: z.literal("active"),
	row_revision: revision,
});
const application = z
	.object({
		id: z.literal(MENTION_APPLICATION_ID),
		type: z.literal("first_party"),
		status: z.literal("active"),
		is_official: z.literal(true),
		is_internal: z.literal(false),
		owner_account_id: z.string().min(1),
		scopes: strings,
		capabilities: strings,
		row_revision: revision,
	})
	.strict();
const workload = z
	.object({
		id: z.string().min(1),
		application_id: z.literal(MENTION_APPLICATION_ID),
		provider: z.literal("aws-iam"),
		subject: z.enum([MENTION_BACKEND_ROLE, MENTION_MCP_ROLE]),
		scopes: strings,
		expires_at: z.null(),
		row_revision: revision,
	})
	.strict();
const credential = z
	.object({
		id: z.string().startsWith("wl_"),
		application_id: z.literal(MENTION_APPLICATION_ID),
		type: z.literal("workload"),
		environment: z.literal("production"),
		status: z.literal("active"),
		expires_at: z.null(),
		scopes: z.array(z.string()).length(0),
		workload_identity_id: z.string().min(1),
		row_revision: revision,
	})
	.strict();
const table = z
	.object({
		status: z.literal("complete"),
		count: z.number().int().nonnegative().max(20),
		rows: z.array(z.unknown()).max(20),
	})
	.strict()
	.refine((value) => value.count === value.rows.length);
const metadata = z.object({
	schemaVersion: z.literal(1),
	profile: z.literal("oxy"),
	readOnly: z.literal(true),
	isolation: z.literal("repeatable read"),
	observedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
	runtime: z
		.object({
			node: z.string(),
			postgresVersion: z.string(),
			postgresEntrySha256: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.strict(),
	tables: z
		.object({
			applications: table,
			application_workload_identities: table,
			application_credentials: table,
			users: table,
			account_closure_fences: table,
			app_capability_catalog_registrations: table,
		})
		.strict(),
});
const mentionMetadata = metadata
	.extend({
		kind: z.literal("mention-foreground-preflight"),
		selectedMentionApplicationId: z.literal(MENTION_APPLICATION_ID),
	})
	.strict();
const registrarMetadata = metadata
	.extend({
		kind: z.literal("oxy-profile-registrar-preflight"),
		proposedRegistrarApplicationId: z.literal(
			OXY_PROFILE_REGISTRAR_APPLICATION_ID,
		),
	})
	.strict();
const rootAccount = account
	.extend({
		kind: z.literal("organization"),
		is_platform_root: z.literal(true),
	})
	.strict();
export interface ForegroundPilotPlan {
	schemaVersion: 1;
	kind: "i05-foreground-configuration";
	nonce: string;
	createdAt: string;
	expiresAt: string;
	expectedApplication: z.infer<typeof application>;
	expectedWorkloads: z.infer<typeof workload>[];
	expectedCredentials: z.infer<typeof credential>[];
	expectedOwners: z.infer<typeof account>[];
	registrarOwner: z.infer<typeof rootAccount>;
	afterScopes: string[];
	afterCapabilities: string[];
	backendWorkloadId: string;
	afterBackendScopes: string[];
}
const planSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.literal("i05-foreground-configuration"),
		nonce: z.string().regex(/^[a-f0-9]{32}$/),
		createdAt: z.string(),
		expiresAt: z.string(),
		expectedApplication: application,
		expectedWorkloads: z.array(workload).length(2),
		expectedCredentials: z.array(credential).length(2),
		expectedOwners: z.array(account.strict()).min(1).max(2),
		registrarOwner: rootAccount,
		afterScopes: strings,
		afterCapabilities: strings,
		backendWorkloadId: z.string().min(1),
		afterBackendScopes: strings,
	})
	.strict();

function exact(actual: unknown, expected: unknown, name: string) {
	if (canonicalCapabilityJson(actual) !== canonicalCapabilityJson(expected))
		throw new Error(`I05 ${name} changed; fresh plan required`);
}
function append(values: string[], item: string) {
	return values.includes(item) ? [...values] : [...values, item];
}

export function prepareForegroundPilotPlan(
	mentionInput: unknown,
	registrarInput: unknown,
): ForegroundPilotPlan {
	const mention = mentionMetadata.parse(mentionInput);
	const registrar = registrarMetadata.parse(registrarInput);
	if (
		mention.tables.applications.rows.length !== 1 ||
		mention.tables.users.rows.length !== 1 ||
		mention.tables.account_closure_fences.count !== 0 ||
		registrar.tables.account_closure_fences.count !== 0 ||
		registrar.tables.users.rows.length !== 1
	)
		throw new Error("I05 owner/application/fence census mismatch");
	for (const name of [
		"applications",
		"application_workload_identities",
		"application_credentials",
		"app_capability_catalog_registrations",
	] as const) {
		if (registrar.tables[name].count !== 0)
			throw new Error(
				"I05 registrar is not absent; reconcile existing identity first",
			);
	}
	const expectedApplication = application.parse(
		mention.tables.applications.rows[0],
	);
	const expectedWorkloads = mention.tables.application_workload_identities.rows
		.map((row) => workload.parse(row))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const expectedCredentials = mention.tables.application_credentials.rows
		.map((row) => credential.parse(row))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const owner = account.strict().parse(mention.tables.users.rows[0]);
	const registrarOwner = rootAccount.parse(registrar.tables.users.rows[0]);
	if (
		owner.id !== expectedApplication.owner_account_id ||
		expectedWorkloads.length !== 2 ||
		expectedCredentials.length !== 2 ||
		new Set(expectedWorkloads.map((row) => row.subject)).size !== 2
	)
		throw new Error("I05 binding/owner census mismatch");
	for (const binding of expectedWorkloads) {
		const identity = expectedCredentials.filter(
			(row) => row.workload_identity_id === binding.id,
		);
		if (identity.length !== 1)
			throw new Error("I05 canonical attribution identity mismatch");
	}
	const backend = expectedWorkloads.find(
		(row) => row.subject === MENTION_BACKEND_ROLE,
	);
	if (!backend) throw new Error("I05 backend binding missing");
	if (
		!expectedApplication.scopes.includes("user:read") ||
		!backend.scopes.includes("user:read") ||
		expectedApplication.scopes.includes("acting-as:offline") ||
		backend.scopes.includes("acting-as:offline")
	) {
		throw new Error("I05 foreground authority differs from approved baseline");
	}
	const owners =
		owner.id === registrarOwner.id
			? [owner]
			: [owner, account.parse(registrarOwner)];
	const now = new Date();
	return {
		schemaVersion: 1,
		kind: "i05-foreground-configuration",
		nonce: randomBytes(16).toString("hex"),
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
		expectedApplication,
		expectedWorkloads,
		expectedCredentials,
		expectedOwners: owners.sort((a, b) => (a.id < b.id ? -1 : 1)),
		registrarOwner,
		afterScopes: append(expectedApplication.scopes, TICKET_SCOPE),
		afterCapabilities: append(expectedApplication.capabilities, COORDINATE),
		backendWorkloadId: backend.id,
		afterBackendScopes: append(backend.scopes, TICKET_SCOPE),
	};
}

/** Must be called before a fresh database read and again under the configuration locks. */
function validateForegroundPilotDefinition(plan: ForegroundPilotPlan) {
	planSchema.parse(plan);
	const ownerIds = [
		...new Set([
			plan.expectedApplication.owner_account_id,
			plan.registrarOwner.id,
		]),
	].sort();
	exact(
		plan.expectedOwners.map((owner) => owner.id),
		ownerIds,
		"owner lock set",
	);
	if (
		new Set(plan.expectedWorkloads.map((binding) => binding.subject)).size !==
			2 ||
		new Set(plan.expectedWorkloads.map((binding) => binding.id)).size !== 2 ||
		plan.expectedWorkloads.some(
			(binding) =>
				plan.expectedCredentials.filter(
					(credential) => credential.workload_identity_id === binding.id,
				).length !== 1,
		)
	) {
		throw new Error("I05 plan canonical binding mismatch");
	}
	application.parse(plan.expectedApplication);
	rootAccount.parse(plan.registrarOwner);
	for (const row of plan.expectedWorkloads) workload.parse(row);
	for (const row of plan.expectedCredentials) credential.parse(row);
	const backend = plan.expectedWorkloads.find(
		(row) => row.subject === MENTION_BACKEND_ROLE,
	);
	if (!backend || plan.backendWorkloadId !== backend.id)
		throw new Error("I05 plan backend mismatch");
	exact(
		plan.afterScopes,
		append(plan.expectedApplication.scopes, TICKET_SCOPE),
		"application scope delta",
	);
	exact(
		plan.afterCapabilities,
		append(plan.expectedApplication.capabilities, COORDINATE),
		"application capability delta",
	);
	exact(
		plan.afterBackendScopes,
		append(backend.scopes, TICKET_SCOPE),
		"workload scope delta",
	);
}

/** Fresh execution additionally checks the fixed, bounded plan lifetime. */
export function validateForegroundPilotPlan(plan: ForegroundPilotPlan) {
	validateForegroundPilotDefinition(plan);
	const created = Date.parse(plan.createdAt);
	const expires = Date.parse(plan.expiresAt);
	const now = Date.now();
	if (
		plan.schemaVersion !== 1 ||
		plan.kind !== "i05-foreground-configuration" ||
		!/^[a-f0-9]{32}$/.test(plan.nonce) ||
		!Number.isFinite(created) ||
		!Number.isFinite(expires) ||
		created > now ||
		now >= expires ||
		expires - created > 30 * 60_000 ||
		expires <= created
	)
		throw new Error("I05 plan invalid or expired");
}

/** Configuration only: no provider/network calls under SQL locks. */
export async function applyForegroundPilotConfiguration(
	plan: ForegroundPilotPlan,
) {
	validateForegroundPilotPlan(plan);
	return getDb().transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = '15000'`);
		await tx.execute(sql`SET LOCAL lock_timeout = '3000'`);
		// Same account-before-application order as account closure/financial authority.
		for (const expected of plan.expectedOwners) {
			const rows = await tx
				.select({
					id: users.id,
					account_status: users.accountStatus,
					row_revision: sql<string>`xmin::text`,
				})
				.from(users)
				.where(eq(users.id, expected.id))
				.for("update");
			exact(rows, [expected], "owner");
		}
		const roots = await tx
			.select({
				id: users.id,
				account_status: users.accountStatus,
				kind: users.kind,
				is_platform_root: sql<boolean>`COALESCE(${users.username} = 'oxy', false)`,
				row_revision: sql<string>`xmin::text`,
			})
			.from(users)
			.where(eq(users.id, plan.registrarOwner.id));
		exact(roots, [plan.registrarOwner], "platform root");
		const fences = await tx
			.select({ accountId: accountClosureFences.accountId })
			.from(accountClosureFences)
			.where(
				inArray(
					accountClosureFences.accountId,
					plan.expectedOwners.map((row) => row.id),
				),
			);
		if (fences.length) throw new Error("I05 owner fenced");
		const app = await tx
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
			.where(eq(applications.id, MENTION_APPLICATION_ID))
			.for("update");
		exact(app, [plan.expectedApplication], "application");
		const bindings = await tx
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
			)
			.orderBy(applicationWorkloadIdentities.id)
			.for("update");
		exact(bindings, plan.expectedWorkloads, "workload binding");
		const identities = await tx
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
			.where(
				and(
					eq(applicationCredentials.applicationId, MENTION_APPLICATION_ID),
					eq(applicationCredentials.type, "workload"),
				),
			)
			.orderBy(applicationCredentials.id)
			.for("update");
		exact(
			identities,
			plan.expectedCredentials,
			"canonical attribution identity",
		);
		const registrars = await tx
			.select({ id: applications.id })
			.from(applications)
			.where(
				sql`${applications.id} = ${OXY_PROFILE_REGISTRAR_APPLICATION_ID} OR ${applications.capabilities} @> ARRAY['catalog:oxy']::text[]`,
			);
		if (registrars.length) throw new Error("I05 registrar no longer absent");
		const sharedBindings = await tx
			.select({ id: applicationWorkloadIdentities.id })
			.from(applicationWorkloadIdentities)
			.where(
				eq(
					applicationWorkloadIdentities.subject,
					"arn:aws:iam::237343248947:role/oxy-ecs-task",
				),
			);
		const catalogs = await tx
			.select({ id: appCapabilityCatalogRegistrations.id })
			.from(appCapabilityCatalogRegistrations)
			.where(eq(appCapabilityCatalogRegistrations.appSlug, "oxy"));
		if (sharedBindings.length || catalogs.length)
			throw new Error("I05 registrar/catalogue preflight changed");
		validateForegroundPilotPlan(plan);
		const { desired } = computeSeedApplicationPlan(null, {
			description: OXY_PROFILE_REGISTRAR_SPEC.description,
			type: "internal",
			ownerAccountId: plan.registrarOwner.id,
			redirectUris: [],
			scopes: ["catalogs:write"],
			capabilities: ["catalog:oxy"],
		});
		await tx.insert(applications).values({
			id: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
			name: OXY_PROFILE_REGISTRAR_SPEC.name,
			createdByUserId: plan.registrarOwner.id,
			...desired,
		});
		const appUpdated = await tx
			.update(applications)
			.set({ scopes: plan.afterScopes, capabilities: plan.afterCapabilities })
			.where(
				and(
					eq(applications.id, MENTION_APPLICATION_ID),
					sql`xmin::text = ${plan.expectedApplication.row_revision}`,
				),
			)
			.returning({ id: applications.id });
		const backend = plan.expectedWorkloads.find(
			(row) => row.id === plan.backendWorkloadId,
		);
		if (!backend || appUpdated.length !== 1)
			throw new Error("I05 application CAS mismatch");
		const bindingUpdated = await tx
			.update(applicationWorkloadIdentities)
			.set({ scopes: plan.afterBackendScopes })
			.where(
				and(
					eq(applicationWorkloadIdentities.id, backend.id),
					sql`xmin::text = ${backend.row_revision}`,
				),
			)
			.returning({ id: applicationWorkloadIdentities.id });
		if (bindingUpdated.length !== 1)
			throw new Error("I05 workload CAS mismatch");
		return {
			applicationId: MENTION_APPLICATION_ID,
			backendWorkloadId: backend.id,
			registrarApplicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
		};
	});
}

/** Caller retains this secret only in memory for the canonical HTTPS token mint. */
export async function createEphemeralRegistrarCredential(
	plan: ForegroundPilotPlan,
) {
	validateForegroundPilotPlan(plan);
	const secret = randomBytes(32).toString("hex");
	const id = randomUUID();
	const publicKey = `oxy_dk_${randomBytes(24).toString("hex")}`;
	const expiresAt = new Date(
		Math.min(Date.now() + 30 * 60_000, Date.parse(plan.expiresAt)),
	);
	await getDb().transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = '15000'`);
		await tx.execute(sql`SET LOCAL lock_timeout = '3000'`);
		await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, plan.registrarOwner.id))
			.for("update");
		const [owner] = await tx
			.select({
				status: users.accountStatus,
				root: sql<boolean>`COALESCE(${users.username} = 'oxy', false)`,
				kind: users.kind,
			})
			.from(users)
			.where(eq(users.id, plan.registrarOwner.id));
		const fences = await tx
			.select({ id: accountClosureFences.accountId })
			.from(accountClosureFences)
			.where(eq(accountClosureFences.accountId, plan.registrarOwner.id));
		if (
			!owner ||
			owner.status !== "active" ||
			!owner.root ||
			owner.kind !== "organization" ||
			fences.length
		)
			throw new Error("I05 registrar owner unavailable");
		const [app] = await tx
			.select({
				owner: applications.ownerAccountId,
				status: applications.status,
				type: applications.type,
				isInternal: applications.isInternal,
				scopes: applications.scopes,
				capabilities: applications.capabilities,
				redirectUris: applications.redirectUris,
			})
			.from(applications)
			.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID))
			.for("update");
		exact(
			app,
			{
				owner: plan.registrarOwner.id,
				status: "active",
				type: "internal",
				isInternal: true,
				scopes: ["catalogs:write"],
				capabilities: ["catalog:oxy"],
				redirectUris: [],
			},
			"registrar authority",
		);
		const existing = await tx
			.select({ id: applicationCredentials.id })
			.from(applicationCredentials)
			.where(
				and(
					eq(
						applicationCredentials.applicationId,
						OXY_PROFILE_REGISTRAR_APPLICATION_ID,
					),
					eq(
						applicationCredentials.name,
						`I05 ephemeral registrar ${plan.nonce}`,
					),
				),
			);
		if (existing.length)
			throw new Error(
				"I05 credential intent already exists; reconcile and retire before retry",
			);
		validateForegroundPilotPlan(plan);
		await tx.insert(applicationCredentials).values({
			id,
			applicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
			name: `I05 ephemeral registrar ${plan.nonce}`,
			type: "service",
			environment: "production",
			publicKey,
			secretHash: createHash("sha256").update(secret).digest("hex"),
			scopes: ["catalogs:write"],
			status: "active",
			expiresAt,
		});
		// Same owner-context attribution as the canonical administrative credential CLI;
		// this is not a claim that an owner-account token proves a human decision.
		await recordCredentialLifecycleEvent(tx, {
			applicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
			credentialId: id,
			eventType: "created",
			actorUserId: plan.registrarOwner.id,
			environment: "production",
			effectiveUntil: expiresAt,
			metadata: {
				administrativeOperation: "i05-foreground-pilot",
				operationNonce: plan.nonce,
			},
		});
	});
	return { id, publicKey, secret, expiresAt };
}

/** Cleanup is maintenance: it remains permitted after expiry or owner withdrawal. */
export async function retireEphemeralRegistrarCredentials(
	plan: ForegroundPilotPlan,
) {
	validateForegroundPilotDefinition(plan);
	return getDb().transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = '15000'`);
		await tx.execute(sql`SET LOCAL lock_timeout = '3000'`);
		await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, plan.registrarOwner.id))
			.for("update");
		const [app] = await tx
			.select({ owner: applications.ownerAccountId })
			.from(applications)
			.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID))
			.for("update");
		if (!app || app.owner !== plan.registrarOwner.id)
			throw new Error("I05 cleanup application ownership changed");
		const credentials = await tx
			.select({
				id: applicationCredentials.id,
				status: applicationCredentials.status,
				type: applicationCredentials.type,
				scopes: applicationCredentials.scopes,
				environment: applicationCredentials.environment,
			})
			.from(applicationCredentials)
			.where(
				and(
					eq(
						applicationCredentials.applicationId,
						OXY_PROFILE_REGISTRAR_APPLICATION_ID,
					),
					eq(
						applicationCredentials.name,
						`I05 ephemeral registrar ${plan.nonce}`,
					),
				),
			)
			.orderBy(applicationCredentials.id)
			.for("update");
		if (credentials.length > 4)
			throw new Error("I05 cleanup credential census exceeded");
		for (const credential of credentials) {
			if (
				credential.type !== "service" ||
				credential.environment !== "production"
			)
				throw new Error("I05 cleanup credential identity changed");
			exact(credential.scopes, ["catalogs:write"], "cleanup scope");
			if (credential.status !== "revoked") {
				await tx
					.update(applicationCredentials)
					.set({ status: "revoked" })
					.where(eq(applicationCredentials.id, credential.id));
				await recordCredentialLifecycleEvent(tx, {
					applicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
					credentialId: credential.id,
					eventType: "revoked",
					actorUserId: plan.registrarOwner.id,
					environment: "production",
					metadata: {
						administrativeOperation: "i05-foreground-pilot",
						operationNonce: plan.nonce,
					},
				});
			}
		}
		return {
			retainedCredentialIds: credentials.map((credential) => credential.id),
			allRevoked: true,
		};
	});
}

/** Administrative rollback preserves the registrar application, credential and catalogue history. */
export async function rollbackForegroundPilotConfiguration(
	plan: ForegroundPilotPlan,
) {
	validateForegroundPilotDefinition(plan); // Maintenance can retire an expired plan; it cannot expand its delta.
	exact(
		plan.afterScopes,
		append(plan.expectedApplication.scopes, TICKET_SCOPE),
		"rollback scope delta",
	);
	exact(
		plan.afterCapabilities,
		append(plan.expectedApplication.capabilities, COORDINATE),
		"rollback capability delta",
	);
	const plannedBackend = plan.expectedWorkloads.find(
		(row) =>
			row.id === plan.backendWorkloadId && row.subject === MENTION_BACKEND_ROLE,
	);
	if (!plannedBackend) throw new Error("I05 rollback backend mismatch");
	exact(
		plan.afterBackendScopes,
		append(plannedBackend.scopes, TICKET_SCOPE),
		"rollback workload delta",
	);
	return getDb().transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = '15000'`);
		await tx.execute(sql`SET LOCAL lock_timeout = '3000'`);
		// Canonical registration takes this lock before writing its application FK.
		// Take it first too, so a registration already in flight cannot invert locks.
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended('capability-catalog:oxy', 0))`,
		);
		for (const owner of plan.expectedOwners) {
			await tx
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, owner.id))
				.for("update");
		}
		const [app] = await tx
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
			.where(eq(applications.id, MENTION_APPLICATION_ID))
			.for("update");
		if (!app) throw new Error("I05 rollback application absent");
		// Refresh xmin while holding locks, and compare all authority fields. Ordinary
		// lastUsedAt writes may change xmin; they never permit changing an authority field.
		exact(
			app,
			{
				...plan.expectedApplication,
				scopes: app.scopes,
				capabilities: app.capabilities,
				row_revision: app.row_revision,
			},
			"rollback application",
		);
		const alreadyRestored =
			canonicalCapabilityJson(app.scopes) ===
				canonicalCapabilityJson(plan.expectedApplication.scopes) &&
			canonicalCapabilityJson(app.capabilities) ===
				canonicalCapabilityJson(plan.expectedApplication.capabilities);
		if (!alreadyRestored) {
			exact(app.scopes, plan.afterScopes, "rollback application scopes");
			exact(
				app.capabilities,
				plan.afterCapabilities,
				"rollback application capabilities",
			);
		}
		const bindings = await tx
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
			)
			.orderBy(applicationWorkloadIdentities.id)
			.for("update");
		if (bindings.length !== plan.expectedWorkloads.length)
			throw new Error("I05 rollback workload census changed");
		for (const expected of plan.expectedWorkloads) {
			const current = bindings.find((binding) => binding.id === expected.id);
			if (!current) throw new Error("I05 rollback workload absent");
			exact(
				current,
				{
					...expected,
					scopes:
						expected.id === plan.backendWorkloadId && !alreadyRestored
							? plan.afterBackendScopes
							: expected.scopes,
					row_revision: current.row_revision,
				},
				"rollback workload",
			);
		}
		const backend = bindings.find(
			(binding) => binding.id === plan.backendWorkloadId,
		);
		const before = plan.expectedWorkloads.find(
			(binding) => binding.id === plan.backendWorkloadId,
		);
		if (!backend || !before) throw new Error("I05 rollback backend absent");
		const identities = await tx
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
			.where(
				and(
					eq(applicationCredentials.applicationId, MENTION_APPLICATION_ID),
					eq(applicationCredentials.type, "workload"),
				),
			)
			.orderBy(applicationCredentials.id)
			.for("update");
		exact(
			identities.map(({ row_revision: _revision, ...row }) => row),
			plan.expectedCredentials.map(
				({ row_revision: _revision, ...row }) => row,
			),
			"rollback canonical attribution identity",
		);
		const [registrar] = await tx
			.select({
				owner: applications.ownerAccountId,
				scopes: applications.scopes,
				status: applications.status,
				isInternal: applications.isInternal,
				redirectUris: applications.redirectUris,
				capabilities: applications.capabilities,
				type: applications.type,
			})
			.from(applications)
			.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID))
			.for("update");
		exact(
			registrar,
			{
				owner: plan.registrarOwner.id,
				scopes: ["catalogs:write"],
				capabilities: ["catalog:oxy"],
				type: "internal",
				status: alreadyRestored ? "suspended" : "active",
				isInternal: true,
				redirectUris: [],
			},
			"rollback registrar",
		);
		const activeCredentials = await tx
			.select({ id: applicationCredentials.id })
			.from(applicationCredentials)
			.where(
				and(
					eq(
						applicationCredentials.applicationId,
						OXY_PROFILE_REGISTRAR_APPLICATION_ID,
					),
					sql`${applicationCredentials.status} <> 'revoked'`,
				),
			);
		if (activeCredentials.length)
			throw new Error("I05 retire registrar credentials before rollback");
		const registrations = await tx
			.select()
			.from(appCapabilityCatalogRegistrations)
			.where(
				sql`${appCapabilityCatalogRegistrations.appSlug} = 'oxy' OR ${appCapabilityCatalogRegistrations.registeredByApplicationId} = ${OXY_PROFILE_REGISTRAR_APPLICATION_ID}`,
			)
			.for("update");
		if (registrations.length > 1)
			throw new Error("I05 rollback catalogue census changed");
		const canonical = oxyProfileCapabilityCatalog();
		for (const registration of registrations) {
			exact(
				{
					app: registration.appSlug,
					version: registration.version,
					digest: registration.digest,
					catalog: registration.catalog,
					audience: registration.audience,
					creator: registration.registeredByApplicationId,
				},
				{
					app: "oxy",
					version: canonical.version,
					digest: digestCatalog(canonical),
					catalog: canonical,
					audience: canonical.audience,
					creator: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
				},
				"rollback catalogue pin",
			);
			const [creator] = await tx
				.select({
					id: applicationCredentials.id,
					status: applicationCredentials.status,
					applicationId: applicationCredentials.applicationId,
					name: applicationCredentials.name,
				})
				.from(applicationCredentials)
				.where(
					eq(applicationCredentials.id, registration.registeredByCredentialId),
				)
				.for("update");
			exact(
				creator,
				{
					id: registration.registeredByCredentialId,
					status: "revoked",
					applicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
					name: `I05 ephemeral registrar ${plan.nonce}`,
				},
				"rollback catalogue creator",
			);
			await tx
				.update(appCapabilityCatalogRegistrations)
				.set({ active: false })
				.where(eq(appCapabilityCatalogRegistrations.id, registration.id));
		}
		if (alreadyRestored)
			return { restoredMention: true, registrarRetainedSuspended: true };
		const restoredApp = await tx
			.update(applications)
			.set({
				scopes: plan.expectedApplication.scopes,
				capabilities: plan.expectedApplication.capabilities,
			})
			.where(
				and(
					eq(applications.id, MENTION_APPLICATION_ID),
					sql`xmin::text = ${app.row_revision}`,
				),
			)
			.returning({ id: applications.id });
		const restoredBinding = await tx
			.update(applicationWorkloadIdentities)
			.set({ scopes: before.scopes })
			.where(
				and(
					eq(applicationWorkloadIdentities.id, backend.id),
					sql`xmin::text = ${backend.row_revision}`,
				),
			)
			.returning({ id: applicationWorkloadIdentities.id });
		if (restoredApp.length !== 1 || restoredBinding.length !== 1)
			throw new Error("I05 rollback CAS mismatch");
		await tx
			.update(applications)
			.set({ status: "suspended" })
			.where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID));
		return { restoredMention: true, registrarRetainedSuspended: true };
	});
}
