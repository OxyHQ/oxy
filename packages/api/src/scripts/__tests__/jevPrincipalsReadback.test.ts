import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workloadAttestationHandle } from "../../services/workloadAttestation.service";
import {
  JEV_KAANA_APPLICATION_ID,
  JEV_MENTION_APPLICATION_ID,
  JEV_MENTION_WORKLOAD_CREDENTIAL_ID,
  JEV_MENTION_WORKLOAD_ROLE_ARN,
  type JevPrincipalsReadbackInput,
  deriveJevMentionWorkloadCredentialId,
  validateJevPrincipalsReadback,
} from "../jevPrincipalsReadback";

const OBSERVED_AT = new Date("2026-10-02T12:00:00.000Z");
const MENTION_OWNER = "mention-owner-0001";
const PARENT_ORG = "oxy-org-0001";
const KAANA_OWNER = "kaana-owner-0001";
const BINDING = "binding-0001";
const KAANA_CREDENTIAL = "01a0aaaa-0000-7000-8000-000000000001";
const SECRET_HASH = "scrypt$never-in-output";
const PUBLIC_KEY = "oxy_dk_neverInOutput";

function validInput(): JevPrincipalsReadbackInput {
  return {
    transactionReadOnly: true,
    transactionIsolation: "repeatable read",
    observedAt: OBSERVED_AT,
    mention: {
      applications: [
        {
          id: JEV_MENTION_APPLICATION_ID,
          status: "active",
          type: "first_party",
          isOfficial: true,
          isInternal: false,
          scopes: ["inference:invoke", "federation:write"],
          ownerAccountId: MENTION_OWNER,
        },
      ],
      owners: [{ id: MENTION_OWNER, accountStatus: "active", closureFenced: false }],
      bindings: [
        {
          id: BINDING,
          applicationId: JEV_MENTION_APPLICATION_ID,
          provider: "aws-iam",
          subject: JEV_MENTION_WORKLOAD_ROLE_ARN,
          scopes: ["inference:invoke", "federation:write"],
          expiresAt: null,
        },
      ],
      credentials: [
        {
          id: JEV_MENTION_WORKLOAD_CREDENTIAL_ID,
          applicationId: JEV_MENTION_APPLICATION_ID,
          type: "workload",
          status: "active",
          scopes: [],
          expiresAt: null,
          workloadIdentityId: BINDING,
        },
      ],
      billing: {
        status: "resolved",
        billingAccount: { accountId: MENTION_OWNER, currency: "USD", billingMode: "prepaid" },
      },
      balances: [
        {
          accountId: MENTION_OWNER,
          currency: "USD",
          purchasedBalance: "3",
          promotionalBalance: "1.5",
          reservedBalance: "0.5",
        },
      ],
      journals: [
        {
          accountId: MENTION_OWNER,
          currency: "USD",
          purchasedFunds: "3",
          promotionalFunds: "1.5",
          reservedFunds: "0.5",
          promotionalGrantEntries: 1,
        },
      ],
    },
    kaana: {
      applications: [
        {
          id: JEV_KAANA_APPLICATION_ID,
          status: "active",
          type: "first_party",
          isOfficial: true,
          isInternal: false,
          scopes: ["inference:invoke"],
          ownerAccountId: KAANA_OWNER,
        },
      ],
      owners: [{ id: KAANA_OWNER, accountStatus: "active", closureFenced: false }],
      credentials: [
        {
          id: KAANA_CREDENTIAL,
          applicationId: JEV_KAANA_APPLICATION_ID,
          type: "service",
          status: "active",
          scopes: ["inference:invoke"],
          expiresAt: null,
          workloadIdentityId: null,
        },
      ],
    },
  };
}

type Mention = JevPrincipalsReadbackInput["mention"];
type Kaana = JevPrincipalsReadbackInput["kaana"];

function withMention(patch: Partial<Mention>): JevPrincipalsReadbackInput {
  const input = validInput();
  return { ...input, mention: { ...input.mention, ...patch } };
}

function withKaana(patch: Partial<Kaana>): JevPrincipalsReadbackInput {
  const input = validInput();
  return { ...input, kaana: { ...input.kaana, ...patch } };
}

function reasonsFor(input: JevPrincipalsReadbackInput) {
  const result = validateJevPrincipalsReadback(input);
  expect(result.status).toBe("blocked");
  return result.blockedReasons;
}

const base = validInput();
const mentionBinding = base.mention.bindings[0]!;
const mentionCredential = base.mention.credentials[0]!;
const mentionApp = base.mention.applications[0]!;
const kaanaCredential = base.kaana.credentials[0]!;

describe("Jev principals readback", () => {
  it("returns only the allowlisted projection when both principals are ready", () => {
    expect(validateJevPrincipalsReadback(validInput())).toEqual({
      schemaVersion: 1,
      status: "ready",
      blockedReasons: [],
      database: {
        engine: "postgresql",
        transactionReadOnly: true,
        transactionIsolation: "repeatable read",
        writes: 0,
      },
      mention: {
        applicationId: JEV_MENTION_APPLICATION_ID,
        ownerAccountId: MENTION_OWNER,
        workloadCredentialId: "wl_d61be5cd068abb658ed4d193",
        bindingId: BINDING,
        effectiveInferenceInvoke: true,
        billing: {
          provisioned: true,
          billingAccountId: MENTION_OWNER,
          inheritedFromAncestor: false,
          accountMode: "prepaid",
          currency: "USD",
          purchasedUsd: "3.00",
          promotionalUsd: "1.50",
          reservedUsd: "0.50",
          promotionalAfterReservesUsd: "1.00",
          minimumPromotionalUsd: "0.01",
          ledgerReconciled: true,
        },
      },
      kaana: {
        applicationId: JEV_KAANA_APPLICATION_ID,
        ownerAccountId: KAANA_OWNER,
        usableInvokeCredentialCount: 1,
        credentials: [
          {
            id: KAANA_CREDENTIAL,
            type: "service",
            status: "active",
            usable: true,
            effectiveInferenceInvoke: true,
          },
        ],
      },
    });
  });

  it("derives the Mention handle from the exact role through the canonical utilities", () => {
    expect(deriveJevMentionWorkloadCredentialId()).toBe("wl_d61be5cd068abb658ed4d193");
    expect(workloadAttestationHandle(JEV_MENTION_WORKLOAD_ROLE_ARN)).toBe(
      JEV_MENTION_WORKLOAD_CREDENTIAL_ID,
    );
    // Any other role derives to another handle, so the pin is not decorative.
    expect(workloadAttestationHandle("arn:aws:iam::237343248947:role/oxy-mention-mcp-task")).not.toBe(
      JEV_MENTION_WORKLOAD_CREDENTIAL_ID,
    );
  });

  it("never echoes keys, secrets, hashes, names, subjects or scopes", () => {
    const leaky = withKaana({
      credentials: [
        {
          ...kaanaCredential,
          publicKey: PUBLIC_KEY,
          secretHash: SECRET_HASH,
          tokenHash: SECRET_HASH,
          name: "Kaana prod key",
        } as never,
      ],
    });
    const serialized = JSON.stringify(validateJevPrincipalsReadback(leaky));
    for (const forbidden of [
      PUBLIC_KEY,
      SECRET_HASH,
      "Kaana prod key",
      JEV_MENTION_WORKLOAD_ROLE_ARN,
      "oxy-mention-task",
      "federation:write",
      "inference:invoke",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  describe("transaction", () => {
    it("refuses without a confirmed read-only transaction", () => {
      expect(() =>
        validateJevPrincipalsReadback({ ...validInput(), transactionReadOnly: false }),
      ).toThrow("read-only");
    });

    it.each(["read committed", "serializable", "", "REPEATABLE READ"])(
      "refuses a %j snapshot",
      (transactionIsolation) => {
        expect(() =>
          validateJevPrincipalsReadback({ ...validInput(), transactionIsolation }),
        ).toThrow("repeatable-read");
      },
    );
  });

  describe("Mention workload binding", () => {
    it("blocks a missing binding, which also leaves the credential unbound", () => {
      expect(reasonsFor(withMention({ bindings: [] }))).toEqual([
        "mention_binding_missing",
        "mention_credential_unbound",
        "mention_effective_invoke_missing",
      ]);
    });

    it("blocks a binding of the role to another application", () => {
      expect(
        reasonsFor(
          withMention({ bindings: [{ ...mentionBinding, applicationId: JEV_KAANA_APPLICATION_ID }] }),
        ),
      ).toEqual(["mention_binding_wrong_application", "mention_effective_invoke_missing"]);
    });

    it("blocks an expired binding by the database clock", () => {
      expect(
        reasonsFor(withMention({ bindings: [{ ...mentionBinding, expiresAt: OBSERVED_AT }] })),
      ).toEqual(["mention_binding_expired"]);
    });

    it("refuses a binding row for any other subject or provider", () => {
      expect(() =>
        validateJevPrincipalsReadback(
          withMention({
            bindings: [{ ...mentionBinding, subject: "arn:aws:iam::237343248947:role/other" }],
          }),
        ),
      ).toThrow("exact Mention provider and subject");
    });

    it("blocks when the binding's scopes do not reach inference:invoke", () => {
      expect(
        reasonsFor(withMention({ bindings: [{ ...mentionBinding, scopes: ["federation:write"] }] })),
      ).toEqual(["mention_effective_invoke_missing"]);
    });

    it("blocks when the application no longer grants inference:invoke", () => {
      expect(
        reasonsFor(
          withMention({ applications: [{ ...mentionApp, scopes: ["federation:write"] }] }),
        ),
      ).toEqual(["mention_effective_invoke_missing"]);
    });
  });

  describe("Mention materialised credential", () => {
    it("blocks a missing workload row instead of assuming it is live", () => {
      expect(reasonsFor(withMention({ credentials: [] }))).toEqual(["mention_credential_missing"]);
    });

    it("blocks a row linked to another binding", () => {
      expect(
        reasonsFor(
          withMention({ credentials: [{ ...mentionCredential, workloadIdentityId: "binding-9" }] }),
        ),
      ).toEqual(["mention_credential_unbound"]);
      expect(
        reasonsFor(withMention({ credentials: [{ ...mentionCredential, workloadIdentityId: null }] })),
      ).toEqual(["mention_credential_unbound"]);
    });

    it("blocks a row of another application or type", () => {
      expect(
        reasonsFor(
          withMention({
            credentials: [{ ...mentionCredential, applicationId: JEV_KAANA_APPLICATION_ID }],
          }),
        ),
      ).toEqual(["mention_credential_wrong_application"]);
      expect(
        reasonsFor(withMention({ credentials: [{ ...mentionCredential, type: "service" }] })),
      ).toEqual(["mention_credential_not_workload"]);
    });

    it("blocks a revoked or expired row", () => {
      expect(
        reasonsFor(withMention({ credentials: [{ ...mentionCredential, status: "revoked" }] })),
      ).toEqual(["mention_credential_inactive"]);
      expect(
        reasonsFor(
          withMention({
            credentials: [{ ...mentionCredential, expiresAt: new Date("2026-10-02T11:00:00.000Z") }],
          }),
        ),
      ).toEqual(["mention_credential_expired"]);
    });

    it("refuses a credential row that is not the derived handle", () => {
      expect(() =>
        validateJevPrincipalsReadback(
          withMention({ credentials: [{ ...mentionCredential, id: "wl_000000000000000000000000" }] }),
        ),
      ).toThrow("derived Mention workload credential");
    });
  });

  describe("Mention application and owner", () => {
    it("blocks a missing application", () => {
      expect(
        reasonsFor(withMention({ applications: [], owners: [], billing: null, balances: [], journals: [] })),
      ).toEqual(["mention_application_missing", "mention_effective_invoke_missing"]);
    });

    it("blocks an inactive or untrusted application", () => {
      expect(
        reasonsFor(withMention({ applications: [{ ...mentionApp, status: "suspended" }] })),
      ).toEqual(["mention_application_inactive"]);
      expect(
        reasonsFor(
          withMention({
            applications: [{ ...mentionApp, type: "third_party", isOfficial: false, isInternal: false }],
          }),
        ),
      ).toEqual(["mention_application_untrusted"]);
    });

    it("blocks a missing, archived or closure-fenced owner", () => {
      expect(reasonsFor(withMention({ owners: [] }))).toEqual(["mention_owner_missing"]);
      expect(
        reasonsFor(withMention({ owners: [{ id: MENTION_OWNER, accountStatus: "archived", closureFenced: false }] })),
      ).toEqual(["mention_owner_inactive"]);
      expect(
        reasonsFor(withMention({ owners: [{ id: MENTION_OWNER, accountStatus: "active", closureFenced: true }] })),
      ).toEqual(["mention_owner_inactive"]);
    });
  });

  describe("Mention billing", () => {
    it("accepts the ancestor account resolveBillingAccount resolves and reports it", () => {
      const result = validateJevPrincipalsReadback(
        withMention({
          billing: {
            status: "resolved",
            billingAccount: { accountId: PARENT_ORG, currency: "USD", billingMode: "prepaid" },
          },
          balances: [{ ...base.mention.balances[0]!, accountId: PARENT_ORG }],
          journals: [{ ...base.mention.journals[0]!, accountId: PARENT_ORG }],
        }),
      );
      expect(result.status).toBe("ready");
      expect(result.mention.billing.billingAccountId).toBe(PARENT_ORG);
      expect(result.mention.billing.inheritedFromAncestor).toBe(true);
    });

    it("refuses balance rows of any account other than the resolved one", () => {
      expect(() =>
        validateJevPrincipalsReadback(
          withMention({
            billing: {
              status: "resolved",
              billingAccount: { accountId: PARENT_ORG, currency: "USD", billingMode: "prepaid" },
            },
          }),
        ),
      ).toThrow("resolved billing account");
    });

    it("blocks an owner with no billing account anywhere in its ancestry", () => {
      const result = validateJevPrincipalsReadback(
        withMention({
          billing: { status: "not-provisioned", accountId: MENTION_OWNER },
          balances: [],
          journals: [],
        }),
      );
      expect(result.blockedReasons).toEqual(["mention_billing_not_provisioned"]);
      expect(result.mention.billing.billingAccountId).toBeNull();
    });

    it("blocks a non-USD billing account and a missing balance", () => {
      expect(
        reasonsFor(
          withMention({
            billing: {
              status: "resolved",
              billingAccount: { accountId: MENTION_OWNER, currency: "EUR", billingMode: "prepaid" },
            },
            balances: [],
            journals: [],
          }),
        ),
      ).toEqual(["mention_billing_currency_not_usd", "mention_balance_missing"]);
    });

    it("counts only the grant: purchased money and a credit line never fund it", () => {
      expect(
        reasonsFor(
          withMention({
            billing: {
              status: "resolved",
              billingAccount: { accountId: MENTION_OWNER, currency: "USD", billingMode: "invoiced" },
            },
            balances: [{ ...base.mention.balances[0]!, purchasedBalance: "9999", promotionalBalance: "0.50" }],
            journals: [{ ...base.mention.journals[0]!, purchasedFunds: "9999", promotionalFunds: "0.50" }],
          }),
        ),
      ).toEqual(["mention_missing_funds"]);
    });

    it("blocks under one cent after reserves and accepts exactly one cent", () => {
      const at = (promotional: string) =>
        withMention({
          balances: [{ ...base.mention.balances[0]!, promotionalBalance: promotional }],
          journals: [{ ...base.mention.journals[0]!, promotionalFunds: promotional }],
        });
      expect(reasonsFor(at("0.509999999999"))).toEqual(["mention_missing_funds"]);
      expect(validateJevPrincipalsReadback(at("0.51")).status).toBe("ready");
    });

    it("blocks a projection the journal does not reproduce and an ungranted balance", () => {
      expect(
        reasonsFor(withMention({ journals: [{ ...base.mention.journals[0]!, reservedFunds: "0" }] })),
      ).toEqual(["mention_ledger_projection_mismatch"]);
      expect(
        reasonsFor(withMention({ journals: [{ ...base.mention.journals[0]!, promotionalGrantEntries: 0 }] })),
      ).toEqual(["mention_promotional_grant_missing"]);
    });

    it("refuses a negative bucket", () => {
      expect(() =>
        validateJevPrincipalsReadback(
          withMention({ balances: [{ ...base.mention.balances[0]!, reservedBalance: "-5" }] }),
        ),
      ).toThrow("negative");
    });
  });

  describe("Kaana credentials", () => {
    it("counts only active, unexpired credentials whose scopes intersect the application's invoke", () => {
      const result = validateJevPrincipalsReadback(
        withKaana({
          credentials: [
            kaanaCredential,
            { ...kaanaCredential, id: "revoked", status: "revoked" },
            { ...kaanaCredential, id: "deprecated", status: "deprecated", expiresAt: new Date("2099-01-01T00:00:00.000Z") },
            { ...kaanaCredential, id: "expired", expiresAt: new Date("2026-10-01T00:00:00.000Z") },
            { ...kaanaCredential, id: "no-invoke", scopes: ["catalogs:write"] },
            { ...kaanaCredential, id: "workload", type: "workload", scopes: [] },
          ],
        }),
      );
      expect(result.kaana.usableInvokeCredentialCount).toBe(1);
      expect(result.kaana.credentials.map((row) => [row.id, row.usable, row.effectiveInferenceInvoke])).toEqual([
        [KAANA_CREDENTIAL, true, true],
        ["revoked", false, false],
        ["deprecated", false, false],
        ["expired", false, false],
        ["no-invoke", true, false],
        ["workload", true, false],
      ]);
    });

    it("blocks when no credential can invoke", () => {
      expect(reasonsFor(withKaana({ credentials: [] }))).toEqual(["kaana_invoke_credential_missing"]);
      const input = validInput();
      expect(
        reasonsFor(
          withKaana({ applications: [{ ...input.kaana.applications[0]!, scopes: ["catalogs:write"] }] }),
        ),
      ).toEqual(["kaana_invoke_credential_missing"]);
    });

    it("blocks a missing or inactive application and owner", () => {
      expect(reasonsFor(withKaana({ applications: [], owners: [] }))).toEqual([
        "kaana_application_missing",
        "kaana_invoke_credential_missing",
      ]);
      expect(reasonsFor(withKaana({ owners: [] }))).toEqual(["kaana_owner_missing"]);
    });

    it("refuses a credential row of another application", () => {
      expect(() =>
        validateJevPrincipalsReadback(
          withKaana({ credentials: [{ ...kaanaCredential, applicationId: JEV_MENTION_APPLICATION_ID }] }),
        ),
      ).toThrow("another application");
    });
  });
});

describe("readback-jev-principals command source", () => {
  // Comments describe what the command refuses; only code is checked.
  const source = readFileSync(join(__dirname, "../../../scripts/readback-jev-principals.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const transactionBody = source.slice(source.indexOf(".transaction(async (tx) =>"));

  it("pins REPEATABLE READ, READ ONLY as the first statement and verifies both before any read", () => {
    const firstStatementAt = transactionBody.search(/await tx\b/);
    expect(
      transactionBody
        .slice(firstStatementAt)
        .replace(/\s+/g, " ")
        .startsWith(
          "await tx.execute( sql`set transaction isolation level repeatable read, read only`, );",
        ),
    ).toBe(true);
    const showReadOnlyAt = transactionBody.indexOf("show transaction_read_only");
    const showIsolationAt = transactionBody.indexOf("show transaction_isolation");
    const guardAt = transactionBody.indexOf("transactionIsolation !== INBOX_PRINCIPAL_READBACK_ISOLATION");
    const firstReadAt = transactionBody.indexOf("now()::text");
    expect(showReadOnlyAt).toBeGreaterThan(firstStatementAt);
    expect(showIsolationAt).toBeGreaterThan(showReadOnlyAt);
    expect(guardAt).toBeGreaterThan(showIsolationAt);
    expect(firstReadAt).toBeGreaterThan(guardAt);
    expect(source.match(/set transaction/g)).toHaveLength(1);
  });

  it("resolves billing on the same transaction", () => {
    expect(transactionBody).toContain("resolveBillingAccount(tx, mentionApp.ownerAccountId)");
    expect(source).not.toMatch(/resolveBillingAccount\(getDb/);
  });

  it("reads no environment beyond DATABASE_URL and selects no secret material", () => {
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/INBOX_APPLICATION_KEY|publicKey|public_key|secretHash|secret_hash|tokenHash|token_hash|tokenPrefix|\bname:/);
  });

  it("performs no write, materialisation, HTTP, mint or inference", () => {
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
    expect(source).not.toMatch(/\b(insert into|update \w+ set|delete from|for update)\b/i);
    expect(source).not.toMatch(
      /ensureWorkloadAttributionIdentity|bindWorkloadIdentity|exchangeWorkloadAttestation|provisionBillingProfile|grantPromotional|fetch\(|axios|https?:|mint|executeInference|OxyInferenceClient/,
    );
    expect(source).not.toMatch(/console\./);
  });
});
