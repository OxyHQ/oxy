import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decisionAvailability } from "../decisionAvailability";
import {
	privateAutoClassifierSourceApproval,
	reviewedPrivateAutoApproval,
} from "../privateAutoClassification";

const frozenBytes = readFileSync(
	resolve(
		__dirname,
		"../../../../../docs/audits/2026-10-05-private-auto-source-approval/reviewed-source-approval.json",
	),
);
const frozen: unknown = JSON.parse(frozenBytes.toString("utf8"));
const beforeExpiry = Date.parse("2026-10-05T00:00:00Z");
const expiry = Date.parse("2026-10-05T22:51:12Z");

describe("reviewed own-Alia private Auto source approval", () => {
	afterEach(() => jest.restoreAllMocks());

	it("returns precisely the frozen reviewed source and actual imported price", () => {
		jest.spyOn(Date, "now").mockReturnValue(beforeExpiry);
		expect(createHash("sha256").update(frozenBytes).digest("hex")).toBe(
			"48cc94c95a4d2c0987facb9c5f1bbe9afaee559d3c3b1d733f91f3ebfcb51d1e",
		);
		expect(privateAutoClassifierSourceApproval()).toEqual(frozen);
	});

	it("returns fresh parsed authority so callers cannot change later admissions", () => {
		jest.spyOn(Date, "now").mockReturnValue(beforeExpiry);
		const approval = privateAutoClassifierSourceApproval();
		expect(approval).toBeDefined();
		if (!approval) throw new Error("Expected reviewed source approval");
		approval.principal.applicationId = "foreign";
		approval.regions.push("unreviewed");
		approval.review.commercialUseAllowed = true;
		expect(privateAutoClassifierSourceApproval()).toEqual(frozen);
	});

	it.each([expiry, expiry + 1, Number.NaN])(
		"refuses expiry or an invalid current clock (%s)",
		(now) => {
			jest.spyOn(Date, "now").mockReturnValue(now);
			expect(privateAutoClassifierSourceApproval()).toBeUndefined();
		},
	);

	it("does not approve missing price or prematurely expired evidence", () => {
		const approval = reviewedPrivateAutoApproval(frozen, beforeExpiry);
		expect(approval).toBeDefined();
		expect(
			reviewedPrivateAutoApproval(
				{ ...approval, priceVersionId: null },
				beforeExpiry,
			),
		).toBeUndefined();
		expect(
			reviewedPrivateAutoApproval(
				{
					...approval,
					review: {
						...approval?.review,
						evidenceExpiresAt: new Date(expiry - 1).toISOString(),
					},
				},
				beforeExpiry,
			),
		).toBeUndefined();
	});

	it("keeps ordinary/public decisions unavailable while this own service approval is valid", () => {
		jest.spyOn(Date, "now").mockReturnValue(beforeExpiry);
		expect(privateAutoClassifierSourceApproval()).toBeDefined();
		expect(decisionAvailability().available).toBe(false);
	});
});
