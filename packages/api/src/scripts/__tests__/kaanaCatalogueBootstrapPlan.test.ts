import {
	type KaanaCatalogueBootstrapPlanInput,
	createKaanaCatalogueBootstrapPlan,
	kaanaBootstrapComparableDeployment,
	kaanaBootstrapExistingFundingEvidence,
	createKaanaCatalogueReviewedFactsSha256,
	requireKaanaCatalogueBootstrapApplyAuthorization,
} from "../kaanaCatalogueBootstrapPlan";

const INPUT: KaanaCatalogueBootstrapPlanInput = {
	reviewerUserId: "69b2d3df5d12f58c9800d651",
	inventorySnapshotId: "snap_exact",
	reviewedFactsSha256: createKaanaCatalogueReviewedFactsSha256({
		price: "0.0001",
		score: 800,
	}),
	publisher: "openai",
	model: "openai/gpt-oss-120b",
	revision: "openai/gpt-oss-120b@observed-2026-09-01",
	candidate: {
		modelReference: "openai/gpt-oss-120b@observed-2026-09-01",
		priority: 100,
	},
	providers: ["cerebras", "groq"],
	deployments: ["dep_cerebras_exact", "dep_groq_exact"],
	routingProfileIds: ["profile-exact"],
	speech: {
		publisher: "x-ai",
		model: "x-ai/text-to-speech",
		revision: "x-ai/text-to-speech@observed-2026-09-24",
		candidate: {
			modelReference: "x-ai/text-to-speech@observed-2026-09-24",
			priority: 100,
		},
		providers: ["xai"],
		deployments: ["dep_xai_tts_observed_2026_09_24"],
		routingProfileIds: ["cc2471c8-807e-46ec-b5da-b6f3b39d2db5"],
	},
	wouldInsert: ["profile:profile-exact"],
};

describe("Kaana catalogue bootstrap plan authorization", () => {
	it("hashes every reviewed identity deterministically", () => {
		const first = createKaanaCatalogueBootstrapPlan(INPUT);
		const second = createKaanaCatalogueBootstrapPlan({ ...INPUT });

		expect(first).toEqual(second);
		expect(first.plan).toMatchObject({
			schemaVersion: 1,
			action: "bootstrap-kaana-catalogue",
			databaseEngine: "postgresql",
		});
		expect(first.planSha256).toMatch(/^[a-f0-9]{64}$/);

		const changed = createKaanaCatalogueBootstrapPlan({
			...INPUT,
			routingProfileIds: ["different-profile"],
		});
		expect(changed.planSha256).not.toBe(first.planSha256);
	});

	it("binds the speech profile, route and candidate into the plan hash", () => {
		const { plan, planSha256 } = createKaanaCatalogueBootstrapPlan(INPUT);
		expect(plan.speech.routingProfileIds).toEqual([
			"cc2471c8-807e-46ec-b5da-b6f3b39d2db5",
		]);
		for (const speech of [
			{ ...INPUT.speech, routingProfileIds: [] },
			{ ...INPUT.speech, deployments: ["dep_xai_other"] },
			{
				...INPUT.speech,
				candidate: { ...INPUT.speech.candidate, priority: 1 },
			},
		]) {
			expect(
				createKaanaCatalogueBootstrapPlan({ ...INPUT, speech }).planSha256,
			).not.toBe(planSha256);
		}
	});

	it("binds source-reviewed facts without volatile database metadata", () => {
		const reviewedFactsSha256 = createKaanaCatalogueReviewedFactsSha256({
			price: "0.0001",
			score: 800,
		});
		const changedFactsSha256 = createKaanaCatalogueReviewedFactsSha256({
			price: "0.0002",
			score: 800,
		});

		expect(changedFactsSha256).not.toBe(reviewedFactsSha256);
		expect(
			createKaanaCatalogueBootstrapPlan({
				...INPUT,
				reviewedFactsSha256: changedFactsSha256,
			}).planSha256,
		).not.toBe(createKaanaCatalogueBootstrapPlan(INPUT).planSha256);
	});

	it("keeps dry runs safe without an apply authorization", () => {
		expect(() =>
			requireKaanaCatalogueBootstrapApplyAuthorization({
				apply: false,
				actualPlanSha256: "",
				expectedPlanSha256: "",
				actor: "",
				reason: "",
			}),
		).not.toThrow();
	});

	it("accepts only the exact dry-run SHA with a bounded actor and reason", () => {
		const { planSha256 } = createKaanaCatalogueBootstrapPlan(INPUT);
		expect(() =>
			requireKaanaCatalogueBootstrapApplyAuthorization({
				apply: true,
				actualPlanSha256: planSha256,
				expectedPlanSha256: planSha256,
				actor: "catalogue-reviewer",
				reason: "OPS-123 reviewed catalogue bootstrap",
			}),
		).not.toThrow();

		for (const authorization of [
			{
				expectedPlanSha256: "",
				actor: "catalogue-reviewer",
				reason: "OPS-123",
			},
			{
				expectedPlanSha256: "0".repeat(64),
				actor: "catalogue-reviewer",
				reason: "OPS-123",
			},
			{
				expectedPlanSha256: planSha256,
				actor: " catalogue-reviewer",
				reason: "OPS-123",
			},
			{
				expectedPlanSha256: planSha256,
				actor: "catalogue-reviewer",
				reason: "OPS-123\nsecond line",
			},
		]) {
			expect(() =>
				requireKaanaCatalogueBootstrapApplyAuthorization({
					apply: true,
					actualPlanSha256: planSha256,
					...authorization,
				}),
			).toThrow();
		}
	});
});

describe("migration 0082 scorecard provenance", () => {
	const url = "https://example.test/reviewed-price";
	it.each([
		"dep_cerebras_gpt_oss_120b_observed_2026_09_01",
		"dep_groq_openai_gpt_oss_120b_observed_2026_09_01",
	])("preserves the historical marker only for existing %s rows", (id) => {
		expect(
			kaanaBootstrapExistingFundingEvidence(id, url, "migration/standard-payg"),
		).toBe("migration/standard-payg");
		expect(kaanaBootstrapExistingFundingEvidence(id, url, undefined)).toBe(url);
		expect(kaanaBootstrapExistingFundingEvidence(id, url, url)).toBe(url);
		expect(kaanaBootstrapExistingFundingEvidence(id, url, "unreviewed")).toBe(
			url,
		);
	});
	it.each([
		"dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01",
		"dep_other",
	])("does not accept migrated provenance for %s", (id) => {
		expect(
			kaanaBootstrapExistingFundingEvidence(id, url, "migration/standard-payg"),
		).toBe(url);
	});
});

describe("existing deployment scope during the storage rename", () => {
	const row = {
		internalRouteId: "dep_cerebras_gpt_oss_120b_observed_2026_09_01",
		permissionStateNote: "stored note",
	};

	it("compares the legacy internal_alia bytes as platform_internal", () => {
		const stored = { ...row, availabilityScope: "internal_alia" };
		expect(kaanaBootstrapComparableDeployment(stored)).toEqual({
			...row,
			availabilityScope: "platform_internal",
		});
		// The stored row itself is never rewritten.
		expect(stored.availabilityScope).toBe("internal_alia");
	});

	it.each(["platform_internal", "enterprise", "public_payg", "unknown"])(
		"compares %s exactly as stored",
		(availabilityScope) => {
			const stored = { ...row, availabilityScope };
			expect(kaanaBootstrapComparableDeployment(stored)).toBe(stored);
		},
	);
});
