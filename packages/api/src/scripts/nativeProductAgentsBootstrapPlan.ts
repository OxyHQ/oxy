import { createHash, timingSafeEqual } from "node:crypto";

export interface NativeProductBootstrapPlan {
  manifestVersion: number;
  direction: "bootstrap" | "rollback";
  /** Full reviewed target, including trust, owners, redirects and scopes. */
  desired: unknown;
  /** Exact non-secret database facts observed under the advisory lock. */
  before: unknown;
  /** Full non-secret state expected after the transaction. */
  after: unknown;
  /** Exact application/account bindings handed to Alia. */
  aliaManifest: unknown;
  operations: readonly string[];
}

export const NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS = [
  "archive-private-bot",
  "suspend-created-clarity-app",
  "revoke-created-clarity-credential",
  "deactivate-alia-agent",
] as const;

export function nativeProductAgentRollbackOperations(input: {
  homiioBotId: string;
  homiioSindiCredentialId: string;
  clarityBotId: string;
  clarityApplicationId: string;
  clarityCredentialId: string;
  clarityBackendApplicationId: string;
  clarityBackendCredentialId: string;
  homiioAgentId: string;
  clarityAgentId: string;
}): string[] {
  return [
    `archive-private account ${input.homiioBotId}`,
    `revoke credential ${input.homiioSindiCredentialId}`,
    `archive-private account ${input.clarityBotId}`,
    `suspend application ${input.clarityApplicationId}`,
    `revoke credential ${input.clarityCredentialId}`,
    `suspend application ${input.clarityBackendApplicationId}`,
    `revoke credential ${input.clarityBackendCredentialId}`,
    `deactivate-in-alia agent ${input.homiioAgentId}`,
    `deactivate-in-alia agent ${input.clarityAgentId}`,
  ];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function nativeProductBootstrapPlanSha256(
  plan: NativeProductBootstrapPlan,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(plan)))
    .digest("hex");
}

export function requireNativeProductBootstrapApproval(
  planSha256: string,
  env: NodeJS.ProcessEnv,
): { actor: string; reason: string } {
  const actor = env.BOOTSTRAP_ACTOR;
  const reason = env.BOOTSTRAP_REASON;
  const expected = env.EXPECTED_PLAN_SHA256;
  if (
    actor === undefined ||
    reason === undefined ||
    actor.length === 0 ||
    reason.length === 0 ||
    actor.trim() !== actor ||
    reason.trim() !== reason ||
    actor.length > 200 ||
    reason.length > 500
  ) {
    throw new Error(
      "APPLY=1 requires exact non-empty BOOTSTRAP_ACTOR and BOOTSTRAP_REASON",
    );
  }
  if (expected !== planSha256) {
    throw new Error(
      `EXPECTED_PLAN_SHA256 must exactly equal the observed plan hash ${planSha256}`,
    );
  }
  return { actor, reason };
}

/**
 * Prove that a protected secret file still represents an already-provisioned
 * fixed service credential. Presence of a database hash is not proof: accepting
 * an unrelated secret here would leave SSM and PostgreSQL permanently split.
 * Error messages intentionally never include either digest.
 */
export function requireExistingServiceCredentialSecretHash(input: {
  label: string;
  existingSecretHash: string | null | undefined;
  suppliedSecretHash: string | undefined;
}): void {
  const existingSecretHash = input.existingSecretHash;
  if (input.suppliedSecretHash === undefined) {
    throw new Error(
      `${input.label} reuse requires its protected service-secret file`,
    );
  }
  if (
    typeof existingSecretHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(existingSecretHash)
  ) {
    throw new Error(`${input.label} stored service-secret hash is malformed`);
  }
  if (!/^[a-f0-9]{64}$/.test(input.suppliedSecretHash)) {
    throw new Error(`${input.label} supplied service-secret hash is malformed`);
  }
  if (
    !timingSafeEqual(
      Buffer.from(existingSecretHash, "hex"),
      Buffer.from(input.suppliedSecretHash, "hex"),
    )
  ) {
    throw new Error(
      `${input.label} protected service secret does not match PostgreSQL`,
    );
  }
}
