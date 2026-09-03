import {
	type KaanaCatalogueBootstrapPlanInput,
	createKaanaCatalogueBootstrapPlan,
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
