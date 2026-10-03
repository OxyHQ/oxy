import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type Transaction, getDb } from "../config/postgres";
import { accountClosureFences } from "../db/schema/accountClosureFences";
import { appGrants } from "../db/schema/appGrants";
import { applicationCredentialAuditEvents } from "../db/schema/applicationCredentialAuditEvents";
import { applicationCredentials } from "../db/schema/applicationCredentials";
import { applications } from "../db/schema/applications";
import { serviceActingAsAuthorityEpochs } from "../db/schema/serviceActingAsAuthorityEpochs";
import { serviceActingAsRevocations } from "../db/schema/serviceActingAsRevocations";
import { users } from "../db/schema/users";
import type { CredentialVerifier } from "../utils/credentialMaterial";
import { recordOperationalCredentialLifecycleEvent } from "./applicationCredentialAudit.service";
import {
	I03_CANARY_APPLICATION_ID,
	I03_CANARY_SCOPES,
	revokeApplicationCredential,
} from "./applicationCredentialRevocation.service";

export const I03_CANARY_OWNER_ID = "69b2d3df5d12f58c9800d651";
export type CanaryOperator = {
	operatorArn: string;
	authorizationSha256: string;
};
export type AliaCanaryPlan = {
	kind: "alia-credential-revocation-canary-v1";
	applicationId: typeof I03_CANARY_APPLICATION_ID;
	ownerAccountId: typeof I03_CANARY_OWNER_ID;
	credentialId: string;
	nonce: string;
	issuedAt: string;
	expiresAt: string;
	grantId: string;
	principalId: string;
	baselineSha256: string;
	authoritySha256: string;
	operator: CanaryOperator;
};
const fail = (): never => {
	throw new Error("alia_canary_precondition_failed");
};
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
function operator(actor: CanaryOperator) {
	if (
		!/^arn:aws:(?:iam|sts)::237343248947:(?:user\/[A-Za-z0-9+=,.@_\/-]+|assumed-role\/[A-Za-z0-9+=,.@_-]+\/[A-Za-z0-9+=,.@_-]+)$/.test(
			actor.operatorArn,
		) ||
		!/^[a-f0-9]{64}$/.test(actor.authorizationSha256)
	)
		fail();
}
function valid(plan: AliaCanaryPlan, issuing: boolean) {
	operator(plan.operator);
	const start = Date.parse(plan.issuedAt);
	const end = Date.parse(plan.expiresAt);
	if (
		plan.kind !== "alia-credential-revocation-canary-v1" ||
		plan.applicationId !== I03_CANARY_APPLICATION_ID ||
		plan.ownerAccountId !== I03_CANARY_OWNER_ID ||
		!/^[0-9a-f-]{36}$/.test(plan.credentialId) ||
		!/^[a-f0-9]{24}$/.test(plan.nonce) ||
		!/^[a-f0-9]{64}$/.test(plan.baselineSha256) ||
		!/^[a-f0-9]{64}$/.test(plan.authoritySha256) ||
		!plan.grantId ||
		!plan.principalId ||
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		end <= start ||
		end - start > 3600_000 ||
		start > Date.now() ||
		(issuing && end <= Date.now())
	)
		fail();
}
function verifier(material: CredentialVerifier) {
	if (
		!/^oxy_dk_[a-f0-9]{48}$/.test(material.publicKey) ||
		!/^[a-f0-9]{64}$/.test(material.secretHash)
	)
		fail();
}
/** Reads only existing consent. No user grant is inserted or changed. */
async function snapshot(tx: Transaction, principalId: string) {
	await tx.execute(sql`set local lock_timeout = '5s'`);
	await tx.execute(sql`set local statement_timeout = '10s'`);
	const accounts = await tx
		.select({
			id: users.id,
			status: users.accountStatus,
			version: sql<string>`xmin::text`,
		})
		.from(users)
		.where(
			inArray(
				users.id,
				[...new Set([I03_CANARY_OWNER_ID, principalId])].sort(),
			),
		)
		.orderBy(users.id)
		.for("share");
	if (
		accounts.length !== new Set([I03_CANARY_OWNER_ID, principalId]).size ||
		accounts.some((row) => row.status !== "active")
	)
		fail();
	const fences = await tx
		.select({ id: accountClosureFences.accountId })
		.from(accountClosureFences)
		.where(
			inArray(
				accountClosureFences.accountId,
				accounts.map((row) => row.id),
			),
		);
	if (fences.length) fail();
	const [app] = await tx
		.select({
			id: applications.id,
			owner: applications.ownerAccountId,
			type: applications.type,
			status: applications.status,
			scopes: applications.scopes,
			version: sql<string>`xmin::text`,
		})
		.from(applications)
		.where(eq(applications.id, I03_CANARY_APPLICATION_ID))
		.for("no key update");
	if (
		!app ||
		app.owner !== I03_CANARY_OWNER_ID ||
		app.status !== "active" ||
		app.type !== "first_party" ||
		!I03_CANARY_SCOPES.every((scope) => app.scopes.includes(scope))
	)
		fail();
	const grants = await tx
		.select({
			id: appGrants.id,
			userId: appGrants.userId,
			scopes: appGrants.scopes,
			version: sql<string>`xmin::text`,
		})
		.from(appGrants)
		.where(eq(appGrants.applicationId, I03_CANARY_APPLICATION_ID))
		.orderBy(appGrants.id)
		.for("share");
	const grant = grants.find((row) => row.userId === principalId);
	if (
		!grant ||
		!I03_CANARY_SCOPES.every((scope) => grant.scopes.includes(scope))
	)
		return fail();
	const revocations = await tx
		.select({ userId: serviceActingAsRevocations.userId })
		.from(serviceActingAsRevocations)
		.where(
			eq(serviceActingAsRevocations.applicationId, I03_CANARY_APPLICATION_ID),
		);
	if (revocations.some((row) => row.userId === principalId)) fail();
	const epochs = await tx
		.select({
			userId: serviceActingAsAuthorityEpochs.userId,
			epoch: sql<string>`epoch::text`,
		})
		.from(serviceActingAsAuthorityEpochs)
		.where(
			eq(
				serviceActingAsAuthorityEpochs.applicationId,
				I03_CANARY_APPLICATION_ID,
			),
		)
		.orderBy(serviceActingAsAuthorityEpochs.userId);
	const credentials = await tx
		.select({
			id: applicationCredentials.id,
			status: applicationCredentials.status,
			scopes: applicationCredentials.scopes,
			type: applicationCredentials.type,
			environment: applicationCredentials.environment,
			expiresAt: applicationCredentials.expiresAt,
			workloadIdentityId: applicationCredentials.workloadIdentityId,
		})
		.from(applicationCredentials)
		.where(eq(applicationCredentials.applicationId, I03_CANARY_APPLICATION_ID))
		.orderBy(applicationCredentials.id)
		.for("share");
	return {
		accounts,
		app,
		grants,
		revocations,
		epochs,
		credentials,
		grantId: grant.id,
	};
}
/** The canonical mint updates app.lastUsedAt (and therefore xmin). After use,
 * compare its unchanged authority fields separately from the pre-issue CAS. */
function authorityDigest(value: Awaited<ReturnType<typeof snapshot>>) {
	return digest({ ...value, app: { ...value.app, version: null } });
}
/** Internal DB-only helper. The launcher authenticates AWS and the exact plan;
 * these strings do not authenticate a person or grant public API access. */
export async function prepareAliaRevocationCanary(
	principalId: string,
	actor: CanaryOperator,
): Promise<AliaCanaryPlan> {
	operator(actor);
	return getDb().transaction(async (tx) => {
		const before = await snapshot(tx, principalId);
		const issuedAt = new Date();
		return {
			kind: "alia-credential-revocation-canary-v1",
			applicationId: I03_CANARY_APPLICATION_ID,
			ownerAccountId: I03_CANARY_OWNER_ID,
			credentialId: randomUUID(),
			nonce: randomBytes(12).toString("hex"),
			issuedAt: issuedAt.toISOString(),
			expiresAt: new Date(issuedAt.getTime() + 3600_000).toISOString(),
			grantId: before.grantId,
			principalId,
			baselineSha256: digest(before),
			authoritySha256: authorityDigest(before),
			operator: { ...actor },
		};
	});
}
export async function issueAliaRevocationCanary(
	plan: AliaCanaryPlan,
	material: CredentialVerifier,
	actor: CanaryOperator,
) {
	operator(actor);
	valid(plan, true);
	if (
		plan.operator.operatorArn !== actor.operatorArn ||
		plan.operator.authorizationSha256 !== actor.authorizationSha256
	)
		fail();
	verifier(material);
	return getDb().transaction(async (tx) => {
		const current = await snapshot(tx, plan.principalId);
		if (
			current.grantId !== plan.grantId ||
			digest(current) !== plan.baselineSha256
		)
			fail();
		valid(plan, true);
		await tx.insert(applicationCredentials).values({
			id: plan.credentialId,
			applicationId: plan.applicationId,
			name: `i03-canary-${plan.nonce}`,
			type: "service",
			environment: "production",
			status: "active",
			publicKey: material.publicKey,
			secretHash: material.secretHash,
			scopes: [...I03_CANARY_SCOPES],
			expiresAt: new Date(plan.expiresAt),
			createdByUserId: null,
		});
		await recordOperationalCredentialLifecycleEvent(tx, {
			applicationId: plan.applicationId,
			credentialId: plan.credentialId,
			eventType: "created",
			environment: "production",
			type: "service",
			...actor,
			nonce: plan.nonce,
		});
		return {
			credentialId: plan.credentialId,
			status: "active" as const,
			expiresAt: plan.expiresAt,
		};
	});
}
/** Cleanup remains possible after expiry, narrowing, closure or app suspension.
 * It retires only this exact newly created row, never a workload or another key. */
export async function revokeAliaRevocationCanary(
	plan: AliaCanaryPlan,
	material: CredentialVerifier,
	actor: CanaryOperator,
) {
	operator(actor);
	valid(plan, false);
	if (
		plan.operator.operatorArn !== actor.operatorArn ||
		plan.operator.authorizationSha256 !== actor.authorizationSha256
	)
		fail();
	verifier(material);
	return revokeApplicationCredential(plan.applicationId, plan.credentialId, {
		kind: "operational_canary",
		...actor,
		nonce: plan.nonce,
		...material,
		expiresAt: new Date(plan.expiresAt),
	});
}

/** Read-only reconciliation. Exact own verifier checks precede any cleanup claim. */
export async function inspectAliaRevocationCanary(
	plan: AliaCanaryPlan,
	material: CredentialVerifier,
	actor: CanaryOperator,
) {
	operator(actor);
	valid(plan, false);
	verifier(material);
	if (
		plan.operator.operatorArn !== actor.operatorArn ||
		plan.operator.authorizationSha256 !== actor.authorizationSha256
	)
		fail();
	return getDb().transaction(
		async (tx) => {
			const [row] = await tx
				.select()
				.from(applicationCredentials)
				.where(eq(applicationCredentials.id, plan.credentialId));
			if (!row) return { exists: false, status: null };
			if (
				row.applicationId !== plan.applicationId ||
				row.name !== `i03-canary-${plan.nonce}` ||
				row.publicKey !== material.publicKey ||
				row.secretHash !== material.secretHash ||
				row.type !== "service" ||
				row.environment !== "production" ||
				row.expiresAt?.toISOString() !== plan.expiresAt ||
				row.createdByUserId !== null ||
				row.rotatedFromCredentialId !== null ||
				row.workloadIdentityId !== null ||
				JSON.stringify(row.scopes) !== JSON.stringify(I03_CANARY_SCOPES)
			)
				fail();
			return { exists: true, status: row.status };
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}
/** Compare existing authority only; caller must also prove exact own-row retirement.
 * A concurrent drift is reported, never silently attributed to this canary. */
export async function verifyAliaCanaryAuthorityUnchanged(
	plan: AliaCanaryPlan,
	actor: CanaryOperator,
) {
	operator(actor);
	valid(plan, false);
	if (
		plan.operator.operatorArn !== actor.operatorArn ||
		plan.operator.authorizationSha256 !== actor.authorizationSha256
	)
		fail();
	return getDb().transaction(async (tx) => {
		const current = await snapshot(tx, plan.principalId);
		current.credentials = current.credentials.filter(
			(row) => row.id !== plan.credentialId,
		);
		return authorityDigest(current) === plan.authoritySha256;
	});
}

/** Recovery after task death, with no plaintext or persisted bearer. The launcher
 * has a durable ID/nonce/operator intent. The immutable creation audit and exact
 * stored row identify only that intent's new credential. Verifier material is
 * read inside this service and never returned or logged. Missing evidence fails.
 */
export async function retireAliaCanaryAfterTaskFailure(
	plan: AliaCanaryPlan,
	actor: CanaryOperator,
) {
	operator(actor);
	valid(plan, false);
	if (
		plan.operator.operatorArn !== actor.operatorArn ||
		plan.operator.authorizationSha256 !== actor.authorizationSha256
	)
		fail();
	const recover = await getDb().transaction(
		async (tx) => {
			const [row] = await tx
				.select()
				.from(applicationCredentials)
				.where(eq(applicationCredentials.id, plan.credentialId));
			if (!row) return null;
			if (
				row.applicationId !== plan.applicationId ||
				row.name !== `i03-canary-${plan.nonce}` ||
				row.type !== "service" ||
				row.environment !== "production" ||
				row.expiresAt?.toISOString() !== plan.expiresAt ||
				row.createdByUserId !== null ||
				row.rotatedFromCredentialId !== null ||
				row.workloadIdentityId !== null ||
				!row.secretHash ||
				JSON.stringify(row.scopes) !== JSON.stringify(I03_CANARY_SCOPES)
			)
				fail();
			const creation = await tx
				.select()
				.from(applicationCredentialAuditEvents)
				.where(
					and(
						eq(
							applicationCredentialAuditEvents.applicationId,
							plan.applicationId,
						),
						eq(
							applicationCredentialAuditEvents.credentialId,
							plan.credentialId,
						),
						eq(applicationCredentialAuditEvents.eventType, "created"),
					),
				);
			if (
				creation.length !== 1 ||
				creation[0].actorUserId !== null ||
				creation[0].environment !== "production"
			)
				return fail();
			const expected = {
				type: "service",
				actorKind: "operational_canary",
				...actor,
				nonce: plan.nonce,
			};
			const meta = creation[0].metadata;
			if (!meta || typeof meta !== "object" || Array.isArray(meta))
				return fail();
			if (
				JSON.stringify(Object.keys(meta).sort()) !==
					JSON.stringify(Object.keys(expected).sort()) ||
				Object.entries(expected).some(
					([key, value]) => Reflect.get(meta, key) !== value,
				)
			)
				return fail();
			if (!row.secretHash || !row.publicKey) return fail();
			if (
				row.createdAt.getTime() < Date.parse(plan.issuedAt) ||
				row.createdAt.getTime() >= Date.parse(plan.expiresAt)
			)
				fail();
			return {
				status: row.status,
				publicKey: row.publicKey,
				secretHash: row.secretHash,
			};
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
	if (!recover)
		return { credentialId: plan.credentialId, exists: false, retired: true };
	if (recover.status !== "revoked")
		await revokeAliaRevocationCanary(plan, recover, actor);
	const current = await inspectAliaRevocationCanary(plan, recover, actor);
	if (!current.exists || current.status !== "revoked") fail();
	return { credentialId: plan.credentialId, exists: true, retired: true };
}
