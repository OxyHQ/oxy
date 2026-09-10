import {
  NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS,
  nativeProductAgentRollbackOperations,
  nativeProductBootstrapPlanSha256,
  requireExistingServiceCredentialSecretHash,
  requireNativeProductBootstrapApproval,
  type NativeProductBootstrapPlan,
} from "../nativeProductAgentsBootstrapPlan";

const plan: NativeProductBootstrapPlan = {
  manifestVersion: 1,
  direction: "bootstrap",
  desired: { scopes: ["user:read"], redirectUris: ["https://example.test"] },
  before: { app: null },
  after: {
    app: { scopes: ["user:read"], redirectUris: ["https://example.test"] },
  },
  aliaManifest: { agents: [{ id: "agent-1", applicationId: "app-1" }] },
  operations: ["insert account by pk", "move app by pk"],
};

describe("native product agent bootstrap approval", () => {
  it("hashes the reviewed plan deterministically", () => {
    expect(nativeProductBootstrapPlanSha256(plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeProductBootstrapPlanSha256(plan)).toBe(
      nativeProductBootstrapPlanSha256({
        ...plan,
        operations: [...plan.operations],
      }),
    );
  });

  it("changes the approval hash when permissions, redirects or Alia bindings change", () => {
    const hash = nativeProductBootstrapPlanSha256(plan);
    expect(
      nativeProductBootstrapPlanSha256({
        ...plan,
        desired: {
          scopes: ["user:read", "inference:invoke"],
          redirectUris: ["https://example.test"],
        },
      }),
    ).not.toBe(hash);
    expect(
      nativeProductBootstrapPlanSha256({
        ...plan,
        desired: { scopes: ["user:read"], redirectUris: ["example://"] },
      }),
    ).not.toBe(hash);
    expect(
      nativeProductBootstrapPlanSha256({
        ...plan,
        aliaManifest: { agents: [{ id: "agent-1", applicationId: "app-2" }] },
      }),
    ).not.toBe(hash);
  });

  it("requires exact actor, reason and observed plan hash for apply", () => {
    const hash = nativeProductBootstrapPlanSha256(plan);
    expect(
      requireNativeProductBootstrapApproval(hash, {
        BOOTSTRAP_ACTOR: "release-bot",
        BOOTSTRAP_REASON: "OPS-123 reviewed bootstrap",
        EXPECTED_PLAN_SHA256: hash,
      }),
    ).toEqual({ actor: "release-bot", reason: "OPS-123 reviewed bootstrap" });
  });

  it.each([
    {},
    {
      BOOTSTRAP_ACTOR: " release-bot",
      BOOTSTRAP_REASON: "OPS-123",
      EXPECTED_PLAN_SHA256: "x",
    },
    {
      BOOTSTRAP_ACTOR: "release-bot",
      BOOTSTRAP_REASON: "OPS-123 ",
      EXPECTED_PLAN_SHA256: "x",
    },
    {
      BOOTSTRAP_ACTOR: "release-bot",
      BOOTSTRAP_REASON: "OPS-123",
      EXPECTED_PLAN_SHA256: "0".repeat(64),
    },
  ])("fails closed for incomplete or mismatched apply approval: %j", (env) => {
    expect(() =>
      requireNativeProductBootstrapApproval("1".repeat(64), env),
    ).toThrow();
  });

  it("keeps product projects and the existing Homiio application out of rollback", () => {
    expect(NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS).toEqual([
      "archive-private-bot",
      "suspend-created-clarity-app",
      "revoke-created-clarity-credential",
      "deactivate-alia-agent",
    ]);
    expect(NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS).not.toContain(
      "archive-project" as never,
    );
    expect(NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS).not.toContain(
      "suspend-homiio-app" as never,
    );
    const operations = nativeProductAgentRollbackOperations({
      homiioBotId: "sindi-bot",
      homiioSindiCredentialId: "sindi-credential",
      clarityBotId: "clarity-bot",
      clarityApplicationId: "clarity-app",
      clarityCredentialId: "clarity-credential",
      clarityBackendApplicationId: "clarity-backend-app",
      clarityBackendCredentialId: "clarity-backend-credential",
      homiioAgentId: "sindi-agent",
      clarityAgentId: "clarity-agent",
    });
    expect(operations.join("\n")).not.toContain("homiio-project");
    expect(operations.join("\n")).not.toContain("homiio-app");
    expect(operations).toEqual([
      "archive-private account sindi-bot",
      "revoke credential sindi-credential",
      "archive-private account clarity-bot",
      "suspend application clarity-app",
      "revoke credential clarity-credential",
      "suspend application clarity-backend-app",
      "revoke credential clarity-backend-credential",
      "deactivate-in-alia agent sindi-agent",
      "deactivate-in-alia agent clarity-agent",
    ]);
  });

  it("fails closed when a fixed credential exists but no protected secret was supplied", () => {
    expect(() =>
      requireExistingServiceCredentialSecretHash({
        label: "Sindi credential",
        existingSecretHash: "a".repeat(64),
        suppliedSecretHash: undefined,
      }),
    ).toThrow("requires its protected service-secret file");
  });

  it("fails closed when the supplied secret does not match the fixed credential", () => {
    expect(() =>
      requireExistingServiceCredentialSecretHash({
        label: "Clarity backend credential",
        existingSecretHash: "a".repeat(64),
        suppliedSecretHash: "b".repeat(64),
      }),
    ).toThrow("does not match PostgreSQL");
  });

  it("allows idempotent reuse only for the exact stored secret hash", () => {
    expect(() =>
      requireExistingServiceCredentialSecretHash({
        label: "Sindi credential",
        existingSecretHash: "c".repeat(64),
        suppliedSecretHash: "c".repeat(64),
      }),
    ).not.toThrow();
  });
});
