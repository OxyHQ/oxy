#!/usr/bin/env bun
/**
 * Phase two of service-credential delivery. `create-service-credential.ts`
 * commits a non-usable `pending` row and emits its encrypted one-time secret.
 * Only after the workflow has durably persisted that recovery package does this
 * exact-id transaction activate the row and deprecate its predecessor.
 */

import { and, eq, ne } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import { applicationCredentials } from "../src/db/schema/applicationCredentials";
import { applications } from "../src/db/schema/applications";
import { recordCredentialLifecycleEvent } from "../src/services/applicationCredentialAudit.service";
import { isCredentialUsable } from "../src/utils/credentialUsability";
import { logger } from "../src/utils/logger";

const ALIA_APPLICATION_ID = "6a2f851751b784a86fd0e934";
const ALIA_CREDENTIAL_NAME = "Oxy service (production)";
const ALIA_SCOPES = ["user:read", "inference:invoke", "capabilities:read"];
const ROTATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function exactScopes(actual: readonly string[]): boolean {
	return (
		actual.length === ALIA_SCOPES.length &&
		ALIA_SCOPES.every((scope) => actual.includes(scope))
	);
}

async function run(): Promise<void> {
	const appId = process.env.APP_ID;
	const credentialId = process.env.FINALIZE_CREDENTIAL_ID;
	if (appId !== ALIA_APPLICATION_ID) {
		throw new Error("Finalization is not registered for this application id.");
	}
	if (!credentialId || !/^[0-9a-f-]{36}$/i.test(credentialId)) {
		throw new Error("FINALIZE_CREDENTIAL_ID must be one exact credential UUID.");
	}

	const result = await getDb().transaction(async (db) => {
		const [application] = await db
			.select({ id: applications.id, status: applications.status })
			.from(applications)
			.where(eq(applications.id, appId))
			.limit(1)
			.for("update");
		if (!application || application.status !== "active") {
			throw new Error("Registered application is missing or inactive.");
		}

		const [credential] = await db
			.select()
			.from(applicationCredentials)
			.where(
				and(
					eq(applicationCredentials.id, credentialId),
					eq(applicationCredentials.applicationId, appId),
				),
			)
			.limit(1)
			.for("update");
		if (
			!credential ||
			credential.name !== ALIA_CREDENTIAL_NAME ||
			credential.type !== "service" ||
			credential.environment !== "production" ||
			!exactScopes(credential.scopes)
		) {
			throw new Error("Pending credential does not match the closed Alia rotation registry.");
		}

		if (credential.status === "active") {
			return { credentialId, status: "already_finalized" as const };
		}
		if (credential.status !== "pending") {
			throw new Error(`Credential cannot be finalized from status ${credential.status}.`);
		}
		const actorUserId = credential.createdByUserId;
		if (!actorUserId) {
			throw new Error("Pending credential has no auditable creator attribution.");
		}

		const namedRows = await db
			.select()
			.from(applicationCredentials)
			.where(
				and(
					eq(applicationCredentials.applicationId, appId),
					eq(applicationCredentials.name, ALIA_CREDENTIAL_NAME),
					eq(applicationCredentials.type, "service"),
					eq(applicationCredentials.environment, "production"),
					ne(applicationCredentials.id, credentialId),
				),
			)
			.for("update");
		const usable = namedRows.filter(isCredentialUsable);
		if (usable.length > 1) {
			throw new Error("Refusing ambiguous Alia predecessor finalization.");
		}
		const predecessor = usable[0] ?? null;
		if ((credential.rotatedFromCredentialId ?? null) !== (predecessor?.id ?? null)) {
			throw new Error("The locked usable predecessor differs from the prepared rotation binding.");
		}

		const graceExpiresAt = predecessor
			? new Date(Date.now() + ROTATION_GRACE_MS)
			: null;
		await db
			.update(applicationCredentials)
			.set({ status: "active" })
			.where(eq(applicationCredentials.id, credentialId));
		if (predecessor && graceExpiresAt) {
			await db
				.update(applicationCredentials)
				.set({ status: "deprecated", expiresAt: graceExpiresAt })
				.where(eq(applicationCredentials.id, predecessor.id));
			await recordCredentialLifecycleEvent(db, {
				applicationId: appId,
				credentialId: predecessor.id,
				eventType: "rotated",
				actorUserId,
				environment: "production",
				metadata: { rotatedToCredentialId: credentialId, graceConfigured: true },
				effectiveUntil: graceExpiresAt,
			});
		}
		await recordCredentialLifecycleEvent(db, {
			applicationId: appId,
			credentialId,
			eventType: "created",
			actorUserId,
			environment: "production",
			metadata: {
				type: "service",
				scopes: ALIA_SCOPES,
				...(predecessor ? { rotatedFromCredentialId: predecessor.id } : {}),
			},
		});
		return {
			credentialId,
			status: "finalized" as const,
			graceExpiresAt: graceExpiresAt?.toISOString() ?? null,
		};
	});

	process.stdout.write(`SERVICE_CRED_FINALIZED_JSON=${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
	await connectPostgres();
	try {
		await run();
	} finally {
		await closePostgres();
	}
}

main().catch((error) => {
	logger.error(
		"Service credential finalization failed",
		error instanceof Error ? error : new Error(String(error)),
		{ component: "finalize-service-credential", method: "main" },
	);
	process.exit(1);
});
