import { reconcilePendingCredentials } from "../serviceCredentialPendingReconciliation";

describe("reconcilePendingCredentials", () => {
  it("performs zero writes and emits zero audit events on dry-run with a pending row", async () => {
    const writes: string[] = [];
    const events: string[] = [];
    const pendingCredentialIds = ["pending-credential"];

    await reconcilePendingCredentials({
      dryRun: true,
      rotateScopeMismatch: true,
      pendingCredentialIds,
      appName: "Alia",
      environment: "production",
      revokeCredential: async (credentialId) => {
        writes.push(credentialId);
      },
      recordRevocation: async (credentialId) => {
        events.push(credentialId);
      },
    });

    expect(writes).toEqual([]);
    expect(events).toEqual([]);
    expect(pendingCredentialIds).toEqual(["pending-credential"]);
  });

  it("revokes and audits each abandoned pending row on apply", async () => {
    const effects: string[] = [];

    await reconcilePendingCredentials({
      dryRun: false,
      rotateScopeMismatch: true,
      pendingCredentialIds: ["pending-a", "pending-b"],
      appName: "Alia",
      environment: "production",
      revokeCredential: async (credentialId) => {
        effects.push(`write:${credentialId}`);
      },
      recordRevocation: async (credentialId) => {
        effects.push(`event:${credentialId}`);
      },
    });

    expect(effects).toEqual([
      "write:pending-a",
      "event:pending-a",
      "write:pending-b",
      "event:pending-b",
    ]);
  });
});
