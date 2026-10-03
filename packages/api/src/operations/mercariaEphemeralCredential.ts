/** Compiled one-shot entrypoint. No AWS CLI, network credential transport, or HTTP registration. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { closePostgres, connectPostgres } from "../config/postgres";
import {
	planSchema,
	stateSchema,
	target,
	verifierSchema,
} from "../services/mercariaEphemeralCredential.contract";
import {
	inspectEphemeralCredential,
	issueEphemeralCredential,
	prepareEphemeralCredential,
	revokeEphemeralCredential,
} from "../services/mercariaEphemeralCredential.service";
const attribution = z
	.object({
		account: z.literal("237343248947"),
		arn: z.string().regex(/^arn:aws:(?:iam|sts)::237343248947:/),
		receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const common = z.object({
	schemaVersion: z.literal(1),
	nonce: z.string().regex(/^[a-f0-9]{32}$/),
	operator: attribution,
});
export const requestSchema = z.discriminatedUnion("mode", [
	common.extend({ mode: z.literal("prepare") }).strict(),
	common
		.extend({
			mode: z.literal("issue"),
			plan: planSchema,
			verifier: verifierSchema,
		})
		.strict(),
	common
		.extend({
			mode: z.literal("inspect"),
			plan: planSchema,
			verifier: verifierSchema,
		})
		.strict(),
	common
		.extend({
			mode: z.literal("revoke"),
			plan: planSchema,
			verifier: verifierSchema,
			expected: stateSchema,
		})
		.strict(),
]);
export async function runEphemeralOperation(input: unknown) {
	const request = requestSchema.parse(input);
	// This attribution was verified by the trusted operator launcher. It is NOT
	// an authenticated AWS identity inside this DB-only container or a user grant.
	const actor = { isPlatformStaff: true, describedAs: request.operator.arn };
	const result =
		request.mode === "prepare"
			? await prepareEphemeralCredential(target, actor)
			: request.mode === "issue"
				? await issueEphemeralCredential(request.plan, request.verifier, actor)
				: request.mode === "inspect"
					? await inspectEphemeralCredential(
							request.plan,
							request.verifier,
							actor,
						)
					: await revokeEphemeralCredential(
							request.plan,
							request.verifier,
							request.expected,
							actor,
						);
	return {
		schemaVersion: 1,
		nonce: request.nonce,
		mode: request.mode,
		operatorReceiptSha256: request.operator.receiptSha256,
		result,
	};
}
async function main() {
	const bytes = process.argv[2];
	if (
		!bytes ||
		createHash("sha256").update(bytes).digest("hex") !== process.argv[3]
	)
		throw new Error("request_hash_mismatch");
	const request = requestSchema.parse(JSON.parse(bytes));
	try {
		await connectPostgres();
		const result = await runEphemeralOperation(request);
		process.stdout.write(`OXY_EPHEMERAL_RESULT ${JSON.stringify(result)}\n`);
	} finally {
		await closePostgres();
	}
}
if (require.main === module)
	void main().catch(() => {
		process.stderr.write(
			"OXY_EPHEMERAL_FAILED: reconcile exact credential ID before any further operation\n",
		);
		process.exitCode = 1;
	});
