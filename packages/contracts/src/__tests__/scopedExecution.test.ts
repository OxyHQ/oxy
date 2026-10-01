import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	inferenceRequestSchema,
	scopedInferenceRequestSchema,
} from "../inference/request";
import {
	SCOPED_EXECUTION_CONTRACT_VERSION,
	SCOPED_REQUEST_ENVELOPE_VERSION,
	canonicalScopedExecutionJson,
	scopedExecutionAudienceSchema,
} from "../inference/scopedExecution";
import { INFERENCE_CONTRACT_VERSION } from "../inference/version";
import {
	scopedAudienceFixture as audience,
	scopedEnvelopeFixture as fixture,
} from "./scopedExecution.fixture";

describe("restrictive scoped envelope", () => {
	it("keeps legacy 3.5/v2 independent of explicit 3.6/v3", () => {
		expect(INFERENCE_CONTRACT_VERSION).toBe("3.5.0");
		expect(SCOPED_EXECUTION_CONTRACT_VERSION).toBe("3.6.0");
		expect(SCOPED_REQUEST_ENVELOPE_VERSION).toBe(3);
		expect(scopedInferenceRequestSchema.safeParse(fixture).success).toBe(true);
		const { scopedExecution, ...normal } = fixture;
		expect(
			inferenceRequestSchema.safeParse({ ...normal, schemaVersion: 2 }).success,
		).toBe(true);
		expect(scopedInferenceRequestSchema.safeParse(normal).success).toBe(false);
		expect(
			inferenceRequestSchema.safeParse({ ...fixture, schemaVersion: 2 })
				.success,
		).toBe(false);
		// A legacy receiver checks literal 2 before it can ignore an unknown scope.
		const legacy35 = inferenceRequestSchema
			.innerType()
			.omit({ scopedExecution: true });
		expect(legacy35.safeParse(fixture).success).toBe(false);
	});
	it.each([
		"requestId",
		"idempotencyKey",
		"deploymentId",
		"provider",
		"modelReference",
	] as const)("rejects mismatched scope %s", (field) => {
		expect(
			scopedInferenceRequestSchema.safeParse({
				...fixture,
				scopedExecution: {
					...fixture.scopedExecution,
					[field]: "foreign_value",
				},
			}).success,
		).toBe(false);
	});
	it.each([
		"accountId",
		"applicationId",
		"credentialId",
		"environment",
	] as const)("binds authenticated principal %s", (field) => {
		expect(
			scopedInferenceRequestSchema.safeParse({
				...fixture,
				scopedExecution: {
					...fixture.scopedExecution,
					principal: {
						...audience.principal,
						[field]: field === "environment" ? "production" : "foreign",
					},
				},
			}).success,
		).toBe(false);
	});
	it("binds policy and refuses extra routes, BYOK, generation and missing scope", () => {
		expect(
			scopedInferenceRequestSchema.safeParse({
				...fixture,
				scopedExecution: {
					...fixture.scopedExecution,
					policy: { ...audience.policy, policyVersion: 2 },
				},
			}).success,
		).toBe(false);
		expect(
			scopedInferenceRequestSchema.safeParse({
				...fixture,
				authorizedRoutes: [
					...fixture.authorizedRoutes,
					...fixture.authorizedRoutes,
				],
			}).success,
		).toBe(false);
		expect(
			scopedInferenceRequestSchema.safeParse({
				...fixture,
				input: { format: "text", text: "synthetic" },
			}).success,
		).toBe(false);
		expect(
			scopedInferenceRequestSchema.safeParse({
				...fixture,
				scopedExecution: undefined,
			}).success,
		).toBe(false);
		expect(
			scopedInferenceRequestSchema.safeParse({
				...fixture,
				scopedExecution: { ...fixture.scopedExecution, publicApproval: true },
			}).success,
		).toBe(false);
	});
	it.each([
		"0",
		"0.010000000001",
		"1",
		"1e-3",
		"-0.001",
		"NaN",
		"0.0000000000001",
	])(
		"refuses invalid or excessive exact price %s without throwing",
		(maxCostUsd) => {
			expect(() =>
				scopedExecutionAudienceSchema.safeParse({ ...audience, maxCostUsd }),
			).not.toThrow();
			expect(
				scopedExecutionAudienceSchema.safeParse({ ...audience, maxCostUsd })
					.success,
			).toBe(false);
		},
	);
	it.each(["0.01", "0.010000000000", "0.000000000001"])(
		"accepts exact bounded price %s",
		(maxCostUsd) => {
			expect(
				scopedExecutionAudienceSchema.safeParse({ ...audience, maxCostUsd })
					.success,
			).toBe(true);
		},
	);
	it("keeps durable permit independent of allocated request identity", () => {
		const parsed = scopedInferenceRequestSchema.parse(fixture);
		expect(parsed.scopedExecution.permitId).not.toBe(
			parsed.attribution.requestId,
		);
		expect(parsed.scopedExecution.requestId).toBe(parsed.attribution.requestId);
	});
	it("uses stable canonical whole input bytes preserving valid Unicode and literal escapes", () => {
		expect(
			canonicalScopedExecutionJson({ z: ["😀", "\\ud800"], a: { b: 1 } }),
		).toBe('{"a":{"b":1},"z":["😀","\\\\ud800"]}');
		expect(canonicalScopedExecutionJson({ b: 2, a: 1 })).toBe(
			canonicalScopedExecutionJson({ a: 1, b: 2 }),
		);
		for (const value of [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			BigInt(1),
			new Date(),
			new Array(1),
		]) {
			expect(() => canonicalScopedExecutionJson(value)).toThrow();
		}
		expect(
			z.object({ schemaVersion: z.literal(2) }).safeParse(fixture).success,
		).toBe(false);
	});
});

describe("frozen cross-language scoped wire fixtures", () => {
	const fixtures = JSON.parse(
		readFileSync(join(__dirname, "scopedExecution.golden.json"), "utf8"),
	) as {
		canonicalInputs: {
			name: string;
			input: unknown;
			canonical: string;
			sha256: string;
		}[];
		audienceCases: { name: string; value: unknown; valid: boolean }[];
		envelopeCases: { name: string; value: unknown; valid: boolean }[];
	};
	it.each(fixtures.canonicalInputs)(
		"preserves exact signed bytes and SHA256: $name",
		(fixture) => {
			const raw = canonicalScopedExecutionJson(fixture.input);
			expect(raw).toBe(fixture.canonical);
			expect(
				createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"),
			).toBe(fixture.sha256);
		},
	);
	it.each(fixtures.audienceCases)(
		"matches shared audience boundary: $name",
		(fixture) => {
			expect(
				scopedExecutionAudienceSchema.safeParse(fixture.value).success,
			).toBe(fixture.valid);
		},
	);
	it.each(fixtures.envelopeCases)(
		"matches shared attributed request boundary: $name",
		(fixture) => {
			expect(
				scopedInferenceRequestSchema.safeParse(fixture.value).success,
			).toBe(fixture.valid);
		},
	);
	it("puts an astral key before U+E000 according to UTF16, not codepoint order", () => {
		const fixture = fixtures.canonicalInputs.find(
			(entry) => entry.name === "utf16-key-order",
		);
		expect(fixture?.canonical).toBe('{"𐀀":"astral","":"bmp"}');
	});
});
