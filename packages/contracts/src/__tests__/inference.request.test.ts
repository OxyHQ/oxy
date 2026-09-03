import {
  authorizedRouteSchema,
  clientRequestMetadataSchema,
  inferenceInputSchema,
  inferenceMessageSchema,
  inferenceRequestSchema,
  safeParseContract,
} from "../index";

const attribution = {
  principal: {
    billing: { accountId: "acc_1" },
    applicationId: "app_1",
    credentialId: "cred_1",
    environment: "production" as const,
    inferenceScopes: ["inference:invoke"],
  },
  requestId: "req_1",
};

const request = {
  schemaVersion: 2 as const,
  attribution,
  target: { kind: "model" as const, modelReference: "openai/gpt-5" },
  modality: "text" as const,
  input: {
    format: "messages" as const,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
      },
    ],
  },
  stream: false,
  sampling: {},
  tools: [],
  client: {
    apiFormat: "chat_completions" as const,
    endpoint: "/v1/chat/completions",
    receivedAt: "2026-08-15T09:41:00.000Z",
  },
  routingPolicy: { routingPolicyId: "rp_1", policyVersion: 3 },
};

describe("inferenceRequestSchema", () => {
  it("parses a minimal normalized request", () => {
    expect(inferenceRequestSchema.safeParse(request).success).toBe(true);
  });

  it('distinguishes "serve this model" from "choose one for me"', () => {
    const concrete = inferenceRequestSchema.parse(request);
    expect(concrete.target.kind).toBe("model");

    const profile = inferenceRequestSchema.parse({
      ...request,
      target: { kind: "routing_profile_id", routingProfileId: "rpf_auto" },
    });
    expect(profile.target.kind).toBe("routing_profile_id");

    // Neither arm accepts the other's field, so intent cannot be lost in transit.
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        target: { kind: "model", routingProfileId: "rpf_auto" },
      }).success,
    ).toBe(false);
  });

  it("rejects a target that is neither a model nor a profile", () => {
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        target: { kind: "whatever_is_cheapest" },
      }).success,
    ).toBe(false);
  });

  it("requires the exact routing policy revision the request was served under", () => {
    const { routingPolicy, ...withoutPolicy } = request;
    expect(routingPolicy.policyVersion).toBe(3);
    expect(inferenceRequestSchema.safeParse(withoutPolicy).success).toBe(false);
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        routingPolicy: { routingPolicyId: "rp_1", policyVersion: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects a tool choice with nothing to choose from", () => {
    expect(
      inferenceRequestSchema.safeParse({ ...request, toolChoice: "auto" })
        .success,
    ).toBe(false);
  });

  it("rejects duplicate tool names in one request", () => {
    const tool = {
      type: "function",
      name: "lookup",
      parameters: { type: "object" },
    };
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        tools: [tool, { ...tool }],
      }).success,
    ).toBe(false);
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        tools: [tool, { ...tool, name: "lookup_other" }],
        toolChoice: { type: "function", name: "lookup" },
      }).success,
    ).toBe(true);
  });

  it("rejects a fractional or negative output-token ceiling", () => {
    expect(
      inferenceRequestSchema.safeParse({ ...request, maxOutputTokens: 1.5 })
        .success,
    ).toBe(false);
    expect(
      inferenceRequestSchema.safeParse({ ...request, maxOutputTokens: 0 })
        .success,
    ).toBe(false);
  });
});

describe("clientRequestMetadataSchema", () => {
  it("records which public dialect the customer called", () => {
    expect(
      safeParseContract(clientRequestMetadataSchema, request.client)?.apiFormat,
    ).toBe("chat_completions");
  });

  it("refuses to carry a client IP, country or user agent", () => {
    // Owner-mandated privacy invariant: no user IP is ever persisted, raw,
    // hashed or geo-derived. `.strict()` is what makes that unbypassable here
    // rather than a rule somebody has to remember when adding a field.
    for (const forbidden of [
      { ip: "203.0.113.7" },
      { ipAddress: "203.0.113.7" },
      { country: "ES" },
      { userAgent: "curl/8.5.0" },
      { forwardedFor: "203.0.113.7" },
    ]) {
      expect(
        clientRequestMetadataSchema.safeParse({
          ...request.client,
          ...forbidden,
        }).success,
      ).toBe(false);
    }
  });
});

describe("inferenceMessageSchema", () => {
  const userMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "hi" }],
  };

  it("parses each role with content parts", () => {
    for (const role of ["system", "developer", "user", "assistant"] as const) {
      expect(
        inferenceMessageSchema.safeParse({ ...userMessage, role }).success,
      ).toBe(true);
    }
  });

  it("requires a tool message to name the call it answers", () => {
    expect(
      inferenceMessageSchema.safeParse({ ...userMessage, role: "tool" })
        .success,
    ).toBe(false);
    expect(
      inferenceMessageSchema.safeParse({
        ...userMessage,
        role: "tool",
        toolCallId: "call_1",
      }).success,
    ).toBe(true);
  });

  it("refuses role-specific fields on the wrong role", () => {
    expect(
      inferenceMessageSchema.safeParse({ ...userMessage, toolCallId: "call_1" })
        .success,
    ).toBe(false);
    expect(
      inferenceMessageSchema.safeParse({
        ...userMessage,
        toolCalls: [{ id: "call_1", name: "lookup", arguments: "{}" }],
      }).success,
    ).toBe(false);
    expect(
      inferenceMessageSchema.safeParse({
        ...userMessage,
        role: "assistant",
        toolCalls: [{ id: "call_1", name: "lookup", arguments: "{}" }],
      }).success,
    ).toBe(true);
  });

  it("keeps tool-call arguments as text a model may have malformed", () => {
    const parsed = inferenceMessageSchema.parse({
      ...userMessage,
      role: "assistant",
      toolCalls: [{ id: "call_1", name: "lookup", arguments: '{"id":' }],
    });
    expect(parsed.toolCalls?.[0].arguments).toBe('{"id":');
  });
});

describe("inferenceInputSchema", () => {
  it("keeps a batch of strings distinct from a one-message conversation", () => {
    expect(
      inferenceInputSchema.parse({ format: "text_batch", texts: ["a", "b"] }),
    ).toEqual({
      format: "text_batch",
      texts: ["a", "b"],
    });
    expect(
      inferenceInputSchema.safeParse({ format: "text_batch", texts: [] })
        .success,
    ).toBe(false);
    expect(
      inferenceInputSchema.safeParse({ format: "messages", messages: [] })
        .success,
    ).toBe(false);
  });

  it("carries a refusal as its own part, never as answer text", () => {
    const parsed = inferenceInputSchema.parse({
      format: "messages",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "do the forbidden thing" }],
        },
        {
          role: "assistant",
          content: [{ type: "refusal", text: "I cannot help with that." }],
        },
      ],
    });

    // A distinct `type`, so no renderer can present the decline as the answer.
    expect(parsed.format).toBe("messages");
    if (parsed.format === "messages") {
      expect(parsed.messages[1].content[0].type).toBe("refusal");
    }
  });

  it("has no member for reasoning, so private working cannot ride as content", () => {
    // The asymmetry with `refusal` above: OpenAI has its own field for a refusal
    // in both of its shapes and none at all for reasoning, and a `text` part
    // would render the model's private working as its answer.
    expect(
      inferenceMessageSchema.safeParse({
        role: "assistant",
        content: [{ type: "reasoning", text: "first I should check whether…" }],
      }).success,
    ).toBe(false);
  });

  it("lets only an assistant message carry a refusal", () => {
    for (const role of ["user", "system", "developer"]) {
      expect(
        inferenceMessageSchema.safeParse({
          role,
          content: [{ type: "refusal", text: "I cannot help with that." }],
        }).success,
      ).toBe(false);
    }

    expect(
      inferenceMessageSchema.safeParse({
        role: "assistant",
        content: [{ type: "refusal", text: "I cannot help with that." }],
      }).success,
    ).toBe(true);
  });

  it("parses multimodal content parts from either source", () => {
    const parsed = inferenceInputSchema.parse({
      format: "messages",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            {
              type: "image",
              source: { kind: "url", url: "https://example.test/a.png" },
            },
            {
              type: "audio",
              source: {
                kind: "inline",
                mediaType: "audio/wav",
                data: "UklGRg==",
              },
            },
          ],
        },
      ],
    });
    expect(parsed.format).toBe("messages");
  });
});

/* -------------------------------------------------------------------------- */
/*  Pre-authorized routes                                                     */
/* -------------------------------------------------------------------------- */

const primaryRoute = {
  substitution: "same_model" as const,
  deploymentId: "dep_openai_usw2_gpt5",
  modelReference: "openai/gpt-5@2026-06-01",
  provider: "openai",
  regions: ["us-west-2"],
};

const sameModelFailover = {
  substitution: "same_model" as const,
  deploymentId: "dep_azure_use1_gpt5",
  modelReference: "openai/gpt-5@2026-06-01",
  provider: "azure",
  regions: ["us-east-1"],
};

const crossModelSubstitute = {
  substitution: "cross_model" as const,
  deploymentId: "dep_anthropic_usw2_opus5",
  modelReference: "anthropic/claude-opus-5@2026-05-01",
  provider: "anthropic",
  regions: ["us-west-2"],
  authorizedByPolicy: true as const,
};

describe("authorizedRouteSchema", () => {
  it("carries what a route needs to be EXECUTED and nothing to re-derive policy from", () => {
    const parsed = authorizedRouteSchema.parse(primaryRoute);
    expect(parsed).toEqual(primaryRoute);

    // No price, no retention flag, no licence id, no availability scope. The
    // arms are strict, so a producer that attaches one fails here rather than
    // shipping a value the data plane could rank on.
    for (const smuggled of [
      { maxPricePerRequest: { amount: "5.000000000000", currency: "USD" } },
      { priceVersionId: "pv_2026_08" },
      { retainsPayloads: false },
      { licenseId: "LicenseRef-Provider-Commercial" },
      { availabilityScope: "public_payg" },
      { upstreamWholesaleCostAmount: "0.500000000000" },
    ]) {
      expect(
        authorizedRouteSchema.safeParse({ ...primaryRoute, ...smuggled })
          .success,
      ).toBe(false);
    }
  });

  it("pins an immutable revision, because the entry names the weights to serve", () => {
    expect(
      authorizedRouteSchema.safeParse({
        ...primaryRoute,
        modelReference: "openai/gpt-5",
      }).success,
    ).toBe(false);
  });

  it("cannot express a cross-model route without authorizing it", () => {
    expect(authorizedRouteSchema.safeParse(crossModelSubstitute).success).toBe(
      true,
    );

    // `authorizedByPolicy` is a literal `true`. Neither omitting it nor setting
    // it to false produces a parseable cross-model entry, so an unauthorized
    // substitution is not a thing this contract can say.
    const { authorizedByPolicy, ...withoutAuthorization } =
      crossModelSubstitute;
    expect(authorizedByPolicy).toBe(true);
    expect(authorizedRouteSchema.safeParse(withoutAuthorization).success).toBe(
      false,
    );
    expect(
      authorizedRouteSchema.safeParse({
        ...crossModelSubstitute,
        authorizedByPolicy: false,
      }).success,
    ).toBe(false);

    // And the same-model arm has no such field to set, so a substitution cannot
    // be laundered through the kind that needs no authorization.
    expect(
      authorizedRouteSchema.safeParse({
        ...primaryRoute,
        authorizedByPolicy: true,
      }).success,
    ).toBe(false);
  });

  it("preserves an empty unattested region set without inventing a location", () => {
    const parsed = authorizedRouteSchema.parse({
      ...primaryRoute,
      regions: [],
    });
    expect(parsed.regions).toEqual([]);
  });
});

describe("inferenceRequestSchema authorizedRoutes", () => {
  it("accepts a request with no list at all, meaning no failover is authorized", () => {
    const parsed = inferenceRequestSchema.parse(request);
    expect(parsed.authorizedRoutes).toBeUndefined();
  });

  it('refuses an EMPTY list rather than reading it as "no failover"', () => {
    // `[]` would be "permission granted, destination unnamed". Absence is how
    // "no failover" is said; an empty grant is not a state this shape has.
    expect(
      inferenceRequestSchema.safeParse({ ...request, authorizedRoutes: [] })
        .success,
    ).toBe(false);
  });

  it("parses the primary, a same-model failover and an authorized substitute in order", () => {
    const parsed = inferenceRequestSchema.parse({
      ...request,
      authorizedRoutes: [primaryRoute, sameModelFailover, crossModelSubstitute],
    });

    // Order IS preference: the data plane fails over by taking the next entry.
    expect(parsed.authorizedRoutes?.map((route) => route.deploymentId)).toEqual(
      [
        "dep_openai_usw2_gpt5",
        "dep_azure_use1_gpt5",
        "dep_anthropic_usw2_opus5",
      ],
    );
  });

  it("accepts an authorized primary whose location is unattested", () => {
    const parsed = inferenceRequestSchema.parse({
      ...request,
      authorizedRoutes: [{ ...primaryRoute, regions: [] }],
    });
    expect(parsed.authorizedRoutes?.[0].regions).toEqual([]);
  });

  it("refuses a list whose first entry claims to be a substitution", () => {
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        target: { kind: "model", modelReference: "anthropic/claude-opus-5" },
        authorizedRoutes: [crossModelSubstitute, primaryRoute],
      }).success,
    ).toBe(false);
  });

  it("refuses a primary that does not serve the model the request named", () => {
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        authorizedRoutes: [
          {
            ...primaryRoute,
            modelReference: "anthropic/claude-opus-5@2026-05-01",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a different model line labelled as same-model failover", () => {
    // The load-bearing negative: a substitution wearing the label that needs no
    // authorization is the one way an unauthorized switch could have travelled.
    const { authorizedByPolicy, ...substituteFields } = crossModelSubstitute;
    expect(authorizedByPolicy).toBe(true);

    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        authorizedRoutes: [
          primaryRoute,
          { ...substituteFields, substitution: "same_model" },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses the same model line labelled as a cross-model substitute", () => {
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        authorizedRoutes: [
          primaryRoute,
          {
            ...sameModelFailover,
            substitution: "cross_model",
            authorizedByPolicy: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("authorizes no substitute at all for a request that pinned a revision", () => {
    const pinned = {
      ...request,
      target: {
        kind: "model" as const,
        modelReference: "openai/gpt-5@2026-06-01",
      },
    };

    expect(
      inferenceRequestSchema.safeParse({
        ...pinned,
        authorizedRoutes: [primaryRoute, sameModelFailover],
      }).success,
    ).toBe(true);

    expect(
      inferenceRequestSchema.safeParse({
        ...pinned,
        authorizedRoutes: [primaryRoute, crossModelSubstitute],
      }).success,
    ).toBe(false);

    // And a pinned request is served on exactly the revision it pinned.
    expect(
      inferenceRequestSchema.safeParse({
        ...pinned,
        authorizedRoutes: [
          { ...primaryRoute, modelReference: "openai/gpt-5@2026-04-11" },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a list that would fail over to the deployment it just left", () => {
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        authorizedRoutes: [
          primaryRoute,
          { ...sameModelFailover, deploymentId: primaryRoute.deploymentId },
        ],
      }).success,
    ).toBe(false);
  });

  it("lets a routing-profile target authorize routes across model lines", () => {
    // The customer named no model, so nothing here is a substitution FOR
    // anything they asked for — but the destinations still have to be named and
    // authorized, one entry each.
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        target: { kind: "routing_profile_id", routingProfileId: "rpf_auto" },
        authorizedRoutes: [primaryRoute, crossModelSubstitute],
      }).success,
    ).toBe(true);
  });

  it("rejects the retired routing-profile slug arm at the signed boundary", () => {
    expect(
      inferenceRequestSchema.safeParse({
        ...request,
        target: { kind: "routing_profile", routingProfile: "auto" },
      }).success,
    ).toBe(false);
  });
});
