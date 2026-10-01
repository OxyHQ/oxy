import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { inferenceRequestSchema } from "@oxy.so/contracts";
import { createHttpKaanaClient } from "../httpKaanaClient";
import { resolveKaanaDataPlane } from "../../config/kaanaDataPlane";
jest.mock("../../config/kaanaDataPlane", () => ({
  resolveKaanaDataPlane: jest.fn(),
  kaanaPublicKeyBase64: jest.fn(),
}));
const attribution = {
  requestId: "req-decision-fixture",
  principal: {
    billing: { accountId: "fixture" },
    applicationId: "fixture",
    credentialId: "fixture",
    environment: "production",
    inferenceScopes: ["inference:invoke"],
  },
};
const envelope = inferenceRequestSchema.parse({
  schemaVersion: 2,
  attribution,
  target: { kind: "model", modelReference: "typesafe/jev@fixture-v1" },
  modality: "text",
  input: {
    format: "decisions",
    decisions: {
      state: "SYNTHETIC",
      questions: [{ id: "exact-Q", kind: "noul", question: "Synthetic?" }],
      effort: "instant",
    },
  },
  stream: false,
  sampling: {},
  tools: [],
  client: {
    apiFormat: "decisions",
    endpoint: "/v1/decisions",
    receivedAt: "2026-10-01T00:00:00Z",
  },
  routingPolicy: { routingPolicyId: "fixture", policyVersion: 1 },
  authorizedRoutes: [
    {
      deploymentId: "fixture",
      modelReference: "typesafe/jev@fixture-v1",
      provider: "typesafe",
      regions: [],
      substitution: "same_model",
    },
  ],
});
const result = {
  schemaVersion: 1,
  requestId: attribution.requestId,
  model: "typesafe/jev@fixture-v1",
  data: [{ id: "exact-Q", kind: "noul", probability: 0.8 }],
  usage: {
    schemaVersion: 2,
    requestId: attribution.requestId,
    attribution,
    outcome: "completed",
    units: [{ unit: "input_tokens", quantity: 10 }],
    usageSource: "provider_reported",
    resolvedModelReference: "typesafe/jev@fixture-v1",
    servingProvider: "typesafe",
    deploymentId: "fixture",
    routeSwitches: 0,
    startedAt: "2026-10-01T00:00:00Z",
    completedAt: "2026-10-01T00:00:01Z",
  },
};
afterEach(() => jest.restoreAllMocks());
function client() {
  const keys = generateKeyPairSync("ed25519");
  jest.mocked(resolveKaanaDataPlane).mockReturnValue({
    status: "configured",
    config: {
      baseUrl: "https://kaana.ai",
      keyId: "synthetic",
      privateKey: keys.privateKey,
    },
  });
  const kaana = createHttpKaanaClient();
  if (!kaana) throw new Error("Missing synthetic client");
  return { client: kaana, keys };
}
it("signs the exact typed body to the sole canonical origin and reads native decisions", async () => {
  const { client: kaana, keys } = client();
  const fetcher = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      expect(url).toBe("https://kaana.ai/internal/v1/decisions");
      if (!init) throw new Error("Missing fetch init");
      const bytes = init.body as Buffer;
      expect(JSON.parse(bytes.toString())).toEqual(envelope);
      const headers = new Headers(init.headers);
      const signed = Buffer.from(
        `oxy-kaana-envelope:v1\nsynthetic\n${headers.get("X-Oxy-Kaana-Timestamp")}\n${createHash("sha256").update(bytes).digest("hex")}`,
      );
      const signature = Buffer.from(
        (headers.get("X-Oxy-Kaana-Signature") ?? "").slice(3),
        "base64",
      );
      expect(verify(null, signed, keys.publicKey, signature)).toBe(true);
      expect(
        verify(
          null,
          Buffer.concat([signed, Buffer.from("tampered")]),
          keys.publicKey,
          signature,
        ),
      ).toBe(false);
      return new Response(JSON.stringify(result));
    });
  await expect(
    kaana.execute(envelope, { signal: new AbortController().signal }),
  ).resolves.toMatchObject({
    decisions: result.data,
    output: [],
    usage: result.usage,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { ...result, data: [{ id: "wrong", kind: "noul", probability: 0.8 }] },
  { ...result, requestId: "wrong-request" },
  { ...result, usage: { ...result.usage, requestId: "foreign" } },
  { ...result, usage: { ...result.usage, outcome: "failed" } },
  { ...result, data: [{ id: "exact-Q", kind: "noul", probability: 2 }] },
  { ...result, model: "typesafe/jev@wrong" },
  { ...result, model: "typesafe/jev@wrong", usage: { ...result.usage, resolvedModelReference: "typesafe/jev@wrong" } },
])(
  "rejects malformed or unbound result without chat reinterpretation",
  async (payload) => {
    const { client: kaana } = client();
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(
      kaana.execute(envelope, { signal: new AbortController().signal }),
    ).rejects.toThrow("Invalid or mismatched decisions");
  },
);
it("rejects stream and foreign API-format envelopes at the contract boundary", () => {
  expect(
    inferenceRequestSchema.safeParse({ ...envelope, stream: true }).success,
  ).toBe(false);
  expect(
    inferenceRequestSchema.safeParse({
      ...envelope,
      client: { ...envelope.client, apiFormat: "responses" },
    }).success,
  ).toBe(false);
  expect(
    inferenceRequestSchema.safeParse({ ...envelope, maxOutputTokens: 20 })
      .success,
  ).toBe(false);
});

it("refuses a substituted model even when a route is signed", () => {
  expect(
    inferenceRequestSchema.safeParse({
      ...envelope,
      authorizedRoutes: [
        {
          ...envelope.authorizedRoutes?.[0],
          modelReference: "typesafe/jev@other",
        },
      ],
    }).success,
  ).toBe(false);
});
