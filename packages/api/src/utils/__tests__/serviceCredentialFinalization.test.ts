import { isValidFinalizedPredecessor } from "../serviceCredentialFinalization";

const expected = {
  applicationId: "alia-app",
  name: "Oxy service (production)",
  type: "service",
  environment: "production",
};

describe("isValidFinalizedPredecessor", () => {
  it("accepts the exact deprecated predecessor after its grace has expired", () => {
    expect(
      isValidFinalizedPredecessor(
        {
          ...expected,
          status: "deprecated",
          expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        },
        expected,
      ),
    ).toBe(true);
  });

  it("rejects a usable row that is not the exact deprecated predecessor", () => {
    expect(
      isValidFinalizedPredecessor(
        {
          ...expected,
          applicationId: "other-app",
          status: "active",
          expiresAt: null,
        },
        expected,
      ),
    ).toBe(false);
  });
});
