import { INBOX_REVIEWED_ROUTING_PROFILE } from "../../config/inboxInference";
import {
  type InboxRoutingProfileReadbackInput,
  validateInboxRoutingProfileReadback,
} from "../inboxRoutingProfileReadback";

const expected = INBOX_REVIEWED_ROUTING_PROFILE;

function validInput(): InboxRoutingProfileReadbackInput {
  return {
    requestedRoutingProfileId: expected.id,
    transactionReadOnly: true,
    profiles: [
      {
        id: expected.id,
        slug: expected.slug,
        displayName: expected.displayName,
        description: expected.description,
        optimiseFor: expected.optimiseFor,
        isProductPreset: expected.isProductPreset,
      },
    ],
    candidates: [
      {
        routingProfileId: expected.id,
        modelReference: expected.candidate.modelReference,
        priority: expected.candidate.priority,
      },
    ],
  };
}

describe("Inbox routing-profile PostgreSQL readback", () => {
  it("returns only the reviewed operator-safe projection", () => {
    expect(validateInboxRoutingProfileReadback(validInput())).toEqual({
      schemaVersion: 1,
      status: "passed",
      database: { engine: "postgresql", transactionReadOnly: true, writes: 0 },
      routingProfile: {
        id: expected.id,
        slug: expected.slug,
        displayName: expected.displayName,
        description: expected.description,
        optimiseFor: expected.optimiseFor,
        isProductPreset: true,
      },
      candidate: {
        modelReference: expected.candidate.modelReference,
        priority: expected.candidate.priority,
      },
    });
  });

  it.each([
    ["an unknown primary key", "01a06477-94f5-74f0-bc25-000000000000"],
    ["leading whitespace", ` ${expected.id}`],
    ["trailing whitespace", `${expected.id} `],
  ])(
    "rejects %s without normalization",
    (_label, requestedRoutingProfileId) => {
      expect(() =>
        validateInboxRoutingProfileReadback({
          ...validInput(),
          requestedRoutingProfileId,
        }),
      ).toThrow();
    },
  );

  it("requires PostgreSQL to confirm the transaction is read only", () => {
    expect(() =>
      validateInboxRoutingProfileReadback({
        ...validInput(),
        transactionReadOnly: false,
      }),
    ).toThrow("read-only transaction");
  });

  it.each([
    ["missing profile", []],
    ["duplicate profile", [...validInput().profiles, ...validInput().profiles]],
  ])("rejects a %s result", (_label, profiles) => {
    expect(() =>
      validateInboxRoutingProfileReadback({
        ...validInput(),
        profiles,
      }),
    ).toThrow("exactly one Inbox routing-profile row");
  });

  it.each([
    ["missing candidate", []],
    [
      "duplicate candidate",
      [...validInput().candidates, ...validInput().candidates],
    ],
  ])("rejects a %s result", (_label, candidates) => {
    expect(() =>
      validateInboxRoutingProfileReadback({
        ...validInput(),
        candidates,
      }),
    ).toThrow("exactly one candidate row");
  });

  it.each([
    ["id", { id: "01a06477-94f5-74f0-bc25-000000000000" }],
    ["slug", { slug: "kaana-v1-renamed" }],
    ["display name", { displayName: "Not Kaana" }],
    ["description", { description: "Unreviewed policy" }],
    ["optimisation", { optimiseFor: "price" }],
    ["product-preset flag", { isProductPreset: false }],
  ])("rejects wrong profile %s metadata", (_label, mutation) => {
    const input = validInput();
    expect(() =>
      validateInboxRoutingProfileReadback({
        ...input,
        profiles: [{ ...input.profiles[0], ...mutation }],
      }),
    ).toThrow("reviewed source metadata");
  });

  it.each([
    [
      "profile ID",
      { routingProfileId: "01a06477-94f5-74f0-bc25-000000000000" },
    ],
    ["model reference", { modelReference: "openai/gpt-oss-120b@wrong" }],
    ["priority", { priority: 101 }],
  ])("rejects a wrong candidate %s", (_label, mutation) => {
    const input = validInput();
    expect(() =>
      validateInboxRoutingProfileReadback({
        ...input,
        candidates: [{ ...input.candidates[0], ...mutation }],
      }),
    ).toThrow("reviewed model and priority");
  });
});
