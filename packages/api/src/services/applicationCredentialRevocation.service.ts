import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../config/postgres";
import {
	applicationCredentials,
	excludeWorkloadRows,
} from "../db/schema/applicationCredentials";
import { NotFoundError } from "../utils/error";
import {
	recordCredentialLifecycleEvent,
	recordOperationalCredentialLifecycleEvent,
} from "./applicationCredentialAudit.service";

export const I03_CANARY_APPLICATION_ID = "6a2f851751b784a86fd0e934";
export const I03_CANARY_SCOPES = [
	"acting-as:offline",
	"inference:invoke",
] as const;

export type CredentialRevocationActor =
	| { kind: "customer"; userId: string }
	| {
			kind: "operational_canary";
			operatorArn: string;
			authorizationSha256: string;
			nonce: string;
			publicKey: string;
			secretHash: string;
			expiresAt: Date;
	  };

/** Internal operation, shared by the customer DELETE route and a reviewed operator helper.
 * The helper authenticates its AWS operator and exact plan; this function is not an
 * authentication endpoint. Operational receipts never pretend to be a customer session.
 */
export async function revokeApplicationCredential(
	applicationId: string,
	credentialId: string,
	actor: CredentialRevocationActor,
) {
	if (
		actor.kind === "operational_canary" &&
		(applicationId !== I03_CANARY_APPLICATION_ID ||
			!/^arn:aws:(?:iam|sts)::237343248947:(?:user\/[A-Za-z0-9+=,.@_\/-]+|assumed-role\/[A-Za-z0-9+=,.@_-]+\/[A-Za-z0-9+=,.@_-]+)$/.test(
				actor.operatorArn,
			) ||
			!/^[a-f0-9]{64}$/.test(actor.authorizationSha256) ||
			!/^[a-f0-9]{24}$/.test(actor.nonce) ||
			!/^oxy_dk_[a-f0-9]{48}$/.test(actor.publicKey) ||
			!/^[a-f0-9]{64}$/.test(actor.secretHash) ||
			!Number.isFinite(actor.expiresAt.getTime()))
	)
		throw new Error("invalid_operational_credential_revocation");
	return getDb().transaction(async (tx) => {
		const [row] = await tx
			.update(applicationCredentials)
			.set({ status: "revoked" })
			.where(
				and(
					eq(applicationCredentials.id, credentialId),
					eq(applicationCredentials.applicationId, applicationId),
					excludeWorkloadRows(),
					...(actor.kind === "operational_canary"
						? [
								eq(applicationCredentials.name, `i03-canary-${actor.nonce}`),
								eq(applicationCredentials.type, "service"),
								eq(applicationCredentials.environment, "production"),
								eq(applicationCredentials.publicKey, actor.publicKey),
								eq(applicationCredentials.secretHash, actor.secretHash),
								eq(applicationCredentials.expiresAt, actor.expiresAt),
								eq(applicationCredentials.scopes, [...I03_CANARY_SCOPES]),
								isNull(applicationCredentials.rotatedFromCredentialId),
								isNull(applicationCredentials.createdByUserId),
							]
						: []),
				),
			)
			.returning({
				id: applicationCredentials.id,
				environment: applicationCredentials.environment,
				type: applicationCredentials.type,
			});
		if (!row) throw new NotFoundError("Credential not found");
		if (actor.kind === "customer") {
			await recordCredentialLifecycleEvent(tx, {
				applicationId,
				credentialId: row.id,
				eventType: "revoked",
				actorUserId: actor.userId,
				environment: row.environment,
				metadata: { type: row.type },
			});
		} else {
			await recordOperationalCredentialLifecycleEvent(tx, {
				applicationId,
				credentialId: row.id,
				eventType: "revoked",
				environment: row.environment,
				type: row.type,
				operatorArn: actor.operatorArn,
				authorizationSha256: actor.authorizationSha256,
				nonce: actor.nonce,
			});
		}
		return row;
	});
}
