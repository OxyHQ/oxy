import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_APPLICATION_ID } from "../../config/inboxInference";
import {
  type InboxPrincipalReadbackInput,
  formatExactUsd,
  parseExactUsd,
  validateInboxPrincipalReadback,
} from "../inboxPrincipalReadback";

const PUBLIC_KEY = "oxy_dk_publicSelectorMustNeverBeEchoed";
const SECRET_HASH = "scrypt$secret-hash-must-never-appear";
const OWNER = "owner-account-0001";
const CREDENTIAL = "01a06134-022c-72b6-a876-27da37a39e39";
const OBSERVED_AT = new Date("2026-10-01T12:00:00.000Z");

function validInput(): InboxPrincipalReadbackInput {
  return {
    requestedApplicationKey: PUBLIC_KEY,
    transactionReadOnly: true,
    observedAt: OBSERVED_AT,
    credentials: [
      {
        id: CREDENTIAL,
        applicationId: INBOX_APPLICATION_ID,
        type: "service",
        status: "active",
        scopes: ["inference:invoke", "email.organize"],
        expiresAt: null,
      },
    ],
    applications: [
      {
        id: INBOX_APPLICATION_ID,
        status: "active",
        scopes: ["inference:invoke"],
        ownerAccountId: OWNER,
      },
    ],
    owners: [{ id: OWNER, accountStatus: "active" }],
    billingProfiles: [
      { accountId: OWNER, currency: "USD", billingMode: "prepaid", status: "active" },
    ],
    balances: [
      {
        accountId: OWNER,
        currency: "USD",
        purchasedBalance: "7.000000000000",
        promotionalBalance: "5.000000000000",
        reservedBalance: "0.250000000000",
      },
    ],
    journals: [
      {
        accountId: OWNER,
        currency: "USD",
        purchasedFunds: "7.000000000000",
        promotionalFunds: "5.000000000000",
        reservedFunds: "0.250000000000",
        promotionalGrantEntries: 1,
      },
    ],
  };
}

function reasonsFor(input: InboxPrincipalReadbackInput) {
  const result = validateInboxPrincipalReadback(input);
  expect(result.status).toBe("blocked");
  return result.blockedReasons;
}

describe("Inbox principal readback", () => {
  it("returns only the allowlisted projection when the principal can pay from granted credit", () => {
    expect(validateInboxPrincipalReadback(validInput())).toEqual({
      schemaVersion: 1,
      status: "ready",
      blockedReasons: [],
      database: { engine: "postgresql", transactionReadOnly: true, writes: 0 },
      credentialId: CREDENTIAL,
      applicationId: INBOX_APPLICATION_ID,
      ownerAccountId: OWNER,
      effectiveInferenceInvoke: true,
      billing: {
        provisioned: true,
        accountMode: "prepaid",
        currency: "USD",
        purchasedUsd: "7.00",
        promotionalUsd: "5.00",
        reservedUsd: "0.25",
        promotionalAfterReservesUsd: "4.75",
        minimumPromotionalUsd: "0.01",
        ledgerReconciled: true,
      },
    });
  });

  it("never echoes the key, secrets, hashes or extra row fields", () => {
    const input = validInput();
    const leaky = {
      ...input,
      credentials: [{ ...input.credentials[0], publicKey: PUBLIC_KEY, secretHash: SECRET_HASH, name: "Inbox prod" }],
      applications: [{ ...input.applications[0], name: "Inbox", webhookSecret: SECRET_HASH }],
    } as unknown as InboxPrincipalReadbackInput;
    const serialized = JSON.stringify(validateInboxPrincipalReadback(leaky));
    expect(serialized).not.toContain(PUBLIC_KEY);
    expect(serialized).not.toContain("oxy_dk_");
    expect(serialized).not.toContain(SECRET_HASH);
    expect(serialized).not.toContain("Inbox prod");
    expect(serialized).not.toContain("email.organize");
    // Blocked results are redacted the same way.
    const blocked = JSON.stringify(
      validateInboxPrincipalReadback({ ...leaky, balances: [] }),
    );
    expect(blocked).not.toContain(PUBLIC_KEY);
    expect(blocked).not.toContain(SECRET_HASH);
  });

  it("refuses to report anything unless PostgreSQL confirmed read-only", () => {
    expect(() =>
      validateInboxPrincipalReadback({ ...validInput(), transactionReadOnly: false }),
    ).toThrow("PostgreSQL did not confirm a read-only transaction");
  });

  it.each(["", " oxy_dk_x", "oxy_dk_x\n"])(
    "refuses a non-exact key selector %j",
    (requestedApplicationKey) => {
      expect(() =>
        validateInboxPrincipalReadback({ ...validInput(), requestedApplicationKey }),
      ).toThrow("INBOX_APPLICATION_KEY must be exact");
    },
  );

  describe("credential", () => {
    const withCredential = (patch: object): InboxPrincipalReadbackInput => {
      const input = validInput();
      return { ...input, credentials: [{ ...input.credentials[0]!, ...patch }] };
    };

    it("blocks a missing credential", () => {
      expect(reasonsFor({ ...validInput(), credentials: [] })).toEqual([
        "credential_missing",
        "effective_invoke_missing",
      ]);
    });

    it("blocks an ambiguous selector instead of picking a row", () => {
      const input = validInput();
      const result = validateInboxPrincipalReadback({
        ...input,
        credentials: [input.credentials[0]!, { ...input.credentials[0]!, id: "other" }],
      });
      expect(result.blockedReasons).toContain("credential_ambiguous");
      expect(result.credentialId).toBeNull();
    });

    it("blocks an expired credential using the database clock", () => {
      expect(
        reasonsFor(withCredential({ expiresAt: new Date("2026-10-01T11:59:59.999Z") })),
      ).toEqual(["credential_expired"]);
      expect(reasonsFor(withCredential({ expiresAt: OBSERVED_AT }))).toEqual([
        "credential_expired",
      ]);
      // Still usable by the local clock, already expired by PostgreSQL's.
      expect(
        reasonsFor({
          ...withCredential({ expiresAt: new Date("2099-01-01T00:00:00.000Z") }),
          observedAt: new Date("2099-06-01T00:00:00.000Z"),
        }),
      ).toEqual(["credential_expired"]);
    });

    it("accepts an active credential that expires after the observation", () => {
      expect(
        validateInboxPrincipalReadback(
          withCredential({ expiresAt: new Date("2099-01-01T00:00:00.000Z") }),
        ).status,
      ).toBe("ready");
    });

    it.each(["revoked", "deprecated", "pending"])("blocks a %s credential", (status) => {
      expect(
        reasonsFor(withCredential({ status, expiresAt: new Date("2099-01-01T00:00:00.000Z") })),
      ).toEqual(["credential_inactive"]);
    });

    it("blocks a credential of another application and denies its authority", () => {
      expect(reasonsFor(withCredential({ applicationId: "6a37b3e61ddfd195b656819c" }))).toEqual([
        "credential_wrong_application",
        "effective_invoke_missing",
      ]);
    });

    it.each(["confidential", "machine", "public", "workload"])(
      "blocks a %s credential",
      (type) => {
        expect(reasonsFor(withCredential({ type }))).toEqual(["credential_not_service"]);
      },
    );

    it("blocks when the effective intersection lacks inference:invoke", () => {
      expect(reasonsFor(withCredential({ scopes: ["email.organize"] }))).toEqual([
        "effective_invoke_missing",
      ]);
      const input = validInput();
      expect(
        reasonsFor({
          ...input,
          applications: [{ ...input.applications[0]!, scopes: ["email.organize"] }],
        }),
      ).toEqual(["effective_invoke_missing"]);
    });
  });

  describe("application and owner", () => {
    it("blocks a missing Inbox application", () => {
      expect(
        reasonsFor({
          ...validInput(),
          applications: [],
          owners: [],
          billingProfiles: [],
          balances: [],
          journals: [],
        }),
      ).toEqual(["application_missing", "effective_invoke_missing", "billing_profile_missing", "balance_missing"]);
    });

    it.each(["suspended", "deleted", "pending_review"])("blocks a %s application", (status) => {
      const input = validInput();
      expect(
        reasonsFor({ ...input, applications: [{ ...input.applications[0]!, status }] }),
      ).toEqual(["application_inactive"]);
    });

    it("refuses an application row that is not the fixed Inbox primary key", () => {
      const input = validInput();
      expect(() =>
        validateInboxPrincipalReadback({
          ...input,
          applications: [{ ...input.applications[0]!, id: "6a37b3e61ddfd195b656819c" }],
        }),
      ).toThrow("fixed Inbox primary key");
    });

    it("blocks a missing owner account", () => {
      const result = validateInboxPrincipalReadback({ ...validInput(), owners: [] });
      expect(result.blockedReasons).toEqual(["owner_missing"]);
      expect(result.ownerAccountId).toBeNull();
    });

    it("blocks an archived owner account", () => {
      expect(
        reasonsFor({ ...validInput(), owners: [{ id: OWNER, accountStatus: "archived" }] }),
      ).toEqual(["owner_inactive"]);
    });

    it("refuses billing rows of any account other than the exact owner", () => {
      const input = validInput();
      expect(() =>
        validateInboxPrincipalReadback({
          ...input,
          owners: [{ id: "someone-else", accountStatus: "active" }],
        }),
      ).toThrow("owner account");
      expect(() =>
        validateInboxPrincipalReadback({
          ...input,
          balances: [{ ...input.balances[0]!, accountId: "parent-org" }],
        }),
      ).toThrow("owner account");
    });
  });

  describe("billing ledger", () => {
    it("blocks a missing billing profile and reports unprovisioned", () => {
      const result = validateInboxPrincipalReadback({ ...validInput(), billingProfiles: [] });
      expect(result.blockedReasons).toEqual(["billing_profile_missing"]);
      expect(result.billing.provisioned).toBe(false);
      expect(result.billing.accountMode).toBeNull();
    });

    it.each(["suspended", "closed"])("blocks a %s billing profile", (status) => {
      const input = validInput();
      expect(
        reasonsFor({ ...input, billingProfiles: [{ ...input.billingProfiles[0]!, status }] }),
      ).toEqual(["billing_profile_inactive"]);
    });

    it("blocks a non-USD profile", () => {
      const input = validInput();
      expect(
        reasonsFor({
          ...input,
          billingProfiles: [{ ...input.billingProfiles[0]!, currency: "EUR" }],
        }),
      ).toEqual(["billing_currency_not_usd"]);
    });

    it("blocks a missing balance without inventing zero amounts", () => {
      const result = validateInboxPrincipalReadback({ ...validInput(), balances: [] });
      expect(result.blockedReasons).toEqual(["balance_missing"]);
      expect(result.billing.promotionalUsd).toBeNull();
      expect(result.billing.provisioned).toBe(false);
    });

    it("blocks when promotional funds after every reserve are under one cent", () => {
      const input = validInput();
      const balance = {
        ...input.balances[0]!,
        promotionalBalance: "0.260000000000",
        reservedBalance: "0.250000000001",
      };
      const journal = {
        ...input.journals[0]!,
        promotionalFunds: balance.promotionalBalance,
        reservedFunds: balance.reservedBalance,
      };
      const result = validateInboxPrincipalReadback({
        ...input,
        balances: [balance],
        journals: [journal],
      });
      expect(result.blockedReasons).toEqual(["missing_funds"]);
      expect(result.billing.promotionalAfterReservesUsd).toBe("0.009999999999");
    });

    it("accepts exactly one cent after reserves", () => {
      const input = validInput();
      const balance = {
        ...input.balances[0]!,
        promotionalBalance: "0.26",
        reservedBalance: "0.25",
      };
      expect(
        validateInboxPrincipalReadback({
          ...input,
          balances: [balance],
          journals: [{ ...input.journals[0]!, promotionalFunds: "0.26", reservedFunds: "0.25" }],
        }).status,
      ).toBe("ready");
    });

    it("never counts purchased money toward the grant", () => {
      const input = validInput();
      const balance = {
        ...input.balances[0]!,
        purchasedBalance: "1000",
        promotionalBalance: "0",
        reservedBalance: "0",
      };
      expect(
        reasonsFor({
          ...input,
          balances: [balance],
          journals: [
            {
              ...input.journals[0]!,
              purchasedFunds: "1000",
              promotionalFunds: "0",
              reservedFunds: "0",
            },
          ],
        }),
      ).toEqual(["missing_funds"]);
    });

    it("blocks a projection the journal does not reproduce", () => {
      const input = validInput();
      const result = validateInboxPrincipalReadback({
        ...input,
        journals: [{ ...input.journals[0]!, promotionalFunds: "4.99" }],
      });
      expect(result.blockedReasons).toEqual(["ledger_projection_mismatch"]);
      expect(result.billing.ledgerReconciled).toBe(false);
      expect(
        reasonsFor({
          ...input,
          journals: [{ ...input.journals[0]!, reservedFunds: "0" }],
        }),
      ).toEqual(["ledger_projection_mismatch"]);
    });

    it("blocks promotional money that no grant entry created", () => {
      const input = validInput();
      expect(
        reasonsFor({
          ...input,
          journals: [{ ...input.journals[0]!, promotionalGrantEntries: 0 }],
        }),
      ).toEqual(["promotional_grant_missing"]);
      expect(reasonsFor({ ...input, journals: [] })).toEqual([
        "ledger_projection_mismatch",
        "promotional_grant_missing",
      ]);
    });

    it.each(["purchasedBalance", "promotionalBalance", "reservedBalance"] as const)(
      "refuses a negative %s instead of reasoning about it",
      (bucket) => {
        const input = validInput();
        // A negative reserve would otherwise ADD to promotional funds.
        expect(() =>
          validateInboxPrincipalReadback({
            ...input,
            balances: [{ ...input.balances[0]!, [bucket]: "-100" }],
          }),
        ).toThrow("A projected balance bucket is negative");
      },
    );

    it("parses and formats exact decimals without rounding", () => {
      expect(parseExactUsd("0.01")).toBe(BigInt("10000000000"));
      expect(formatExactUsd(parseExactUsd("-1.000000000001"))).toBe("-1.000000000001");
      expect(() => parseExactUsd("1e3")).toThrow("not an exact decimal");
      expect(() => parseExactUsd("0.0000000000001")).toThrow("not an exact decimal");
    });
  });
});

describe("readback-inbox-principal command source", () => {
  // Comments describe what the command refuses; only code is checked.
  const source = readFileSync(
    join(__dirname, "../../../scripts/readback-inbox-principal.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("makes SET TRANSACTION READ ONLY the first statement and verifies it", () => {
    const transactionBody = source.slice(source.indexOf(".transaction(async (tx) =>"));
    const firstStatement = /await tx\.(\w+)\(([^)]*)\)/.exec(transactionBody);
    expect(firstStatement?.[0]).toBe("await tx.execute(sql`set transaction read only`)");
    expect(transactionBody.indexOf("show transaction_read_only")).toBeGreaterThan(
      transactionBody.indexOf("set transaction read only"),
    );
  });

  it("reads only DATABASE_URL and INBOX_APPLICATION_KEY and performs no write, HTTP or mint", () => {
    expect(source.match(/process\.env\.\w+/g)).toEqual(["process.env.INBOX_APPLICATION_KEY"]);
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
    expect(source).not.toMatch(/\b(insert into|update \w+ set|delete from|for update)\b/i);
    expect(source).not.toMatch(/\bfetch\(|axios|http|createLinkedClient|mint|executeInference/i);
    expect(source).not.toMatch(/secretHash|tokenHash|secret_hash|token_hash|tokenPrefix/);
    expect(source).not.toMatch(/console\./);
  });
});
