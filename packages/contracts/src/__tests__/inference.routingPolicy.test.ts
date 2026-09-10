import {
  routingPolicyReferenceSchema,
  routingPolicySchema,
  safeParseContract,
} from "../index";

const policy = {
  schemaVersion: 2 as const,
  routingPolicyId: "rp_1",
  policyVersion: 7,
  scope: {
    kind: "application" as const,
    accountId: "acc_1",
    applicationId: "app_1",
  },
  providerAllowlist: [],
  providerDenylist: [],
  allowedRegions: [],
  deniedRegions: [],
  requireZeroDataRetention: false,
  prohibitTrainingOnCustomerData: true,
  maxPricePerUnit: [],
  optimiseFor: "balanced" as const,
  oxyHostedOnly: false,
  allowedLicenseIds: [],
  requireCommercialUseRights: true,
  fallback: {
    disabled: false,
    sameModelDeployment: true,
    authorizedCrossModel: [],
  },
  byokPreference: "disabled" as const,
  dedicatedCapacity: "disabled" as const,
  updatedAt: "2026-08-15T09:00:00.000Z",
};

describe("routingPolicySchema", () => {
  it("parses a policy with every control at its default", () => {
    expect(routingPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("carries every control the control plane owns", () => {
    const controls = Object.keys(routingPolicySchema.innerType().shape);
    for (const control of [
      "defaultTarget",
      "providerAllowlist",
      "providerDenylist",
      "allowedRegions",
      "deniedRegions",
      "requireZeroDataRetention",
      "prohibitTrainingOnCustomerData",
      "maxPricePerUnit",
      "maxPricePerRequest",
      "optimiseFor",
      "oxyHostedOnly",
      "allowedLicenseIds",
      "requireCommercialUseRights",
      "fallback",
      "byokPreference",
      "dedicatedCapacity",
      "policyVersion",
    ]) {
      expect(controls).toContain(control);
    }
  });

  it("keeps the customer policy version separate from the wire schema version", () => {
    const parsed = routingPolicySchema.parse({ ...policy, policyVersion: 41 });
    expect(parsed.policyVersion).toBe(41);
    expect(parsed.schemaVersion).toBe(2);
  });

  it("rejects a provider that is both required and denied", () => {
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        providerAllowlist: ["openai", "anthropic"],
        providerDenylist: ["anthropic"],
      }).success,
    ).toBe(false);
  });

  it("rejects a region that is both allowed and denied", () => {
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        allowedRegions: ["us-west-2"],
        deniedRegions: ["us-west-2"],
      }).success,
    ).toBe(false);
  });

  it("rejects fallback disabled beside any fallback route", () => {
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        fallback: {
          disabled: true,
          sameModelDeployment: true,
          authorizedCrossModel: [],
        },
      }).success,
    ).toBe(false);

    expect(
      routingPolicySchema.safeParse({
        ...policy,
        fallback: {
          disabled: true,
          sameModelDeployment: false,
          authorizedCrossModel: ["openai/gpt-5"],
        },
      }).success,
    ).toBe(false);

    expect(
      routingPolicySchema.safeParse({
        ...policy,
        fallback: {
          disabled: true,
          sameModelDeployment: false,
          authorizedCrossModel: [],
        },
      }).success,
    ).toBe(true);
  });

  it("names the models a cross-model fallback may use, rather than allowing any", () => {
    const parsed = routingPolicySchema.parse({
      ...policy,
      fallback: {
        disabled: false,
        sameModelDeployment: true,
        authorizedCrossModel: ["openai/gpt-5", "meta/llama-4-70b"],
      },
    });
    expect(parsed.fallback.authorizedCrossModel).toEqual([
      "openai/gpt-5",
      "meta/llama-4-70b",
    ]);

    expect(
      routingPolicySchema.safeParse({
        ...policy,
        fallback: {
          disabled: false,
          sameModelDeployment: true,
          authorizedCrossModel: ["*"],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an Oxy-hosted-only policy that also requires a customer credential", () => {
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        oxyHostedOnly: true,
        byokPreference: "require",
      }).success,
    ).toBe(false);
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        oxyHostedOnly: true,
        byokPreference: "prefer",
      }).success,
    ).toBe(true);
  });

  it("rejects two ceilings for one unit, or ceilings in mixed currencies", () => {
    const ceiling = {
      unit: "output_tokens",
      amount: "20.00",
      per: 1000000,
      currency: "USD",
    };

    expect(
      routingPolicySchema.safeParse({
        ...policy,
        maxPricePerUnit: [ceiling, { ...ceiling }],
      }).success,
    ).toBe(false);

    expect(
      routingPolicySchema.safeParse({
        ...policy,
        maxPricePerUnit: [ceiling],
        maxPricePerRequest: { amount: "5.000000000000", currency: "EUR" },
      }).success,
    ).toBe(false);

    expect(
      routingPolicySchema.safeParse({
        ...policy,
        maxPricePerUnit: [ceiling],
        maxPricePerRequest: { amount: "5.000000000000", currency: "USD" },
      }).success,
    ).toBe(true);
  });

  it("rejects a per-request ceiling written as a float", () => {
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        maxPricePerRequest: { amount: 5.5, currency: "USD" },
      }).success,
    ).toBe(false);
  });

  it("scopes a policy to an account or to an application, not to a user", () => {
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        scope: { kind: "account", accountId: "acc_1" },
      }).success,
    ).toBe(true);
    expect(
      routingPolicySchema.safeParse({
        ...policy,
        scope: { kind: "user", userId: "usr_1" },
      }).success,
    ).toBe(false);
  });
});

describe("routingPolicyReferenceSchema", () => {
  it("records exactly which policy revision served a request", () => {
    expect(
      safeParseContract(routingPolicyReferenceSchema, {
        routingPolicyId: "rp_1",
        policyVersion: 7,
      }),
    ).toEqual({ routingPolicyId: "rp_1", policyVersion: 7 });
  });

  it("refuses an unversioned reference", () => {
    expect(
      routingPolicyReferenceSchema.safeParse({ routingPolicyId: "rp_1" })
        .success,
    ).toBe(false);
  });
});
