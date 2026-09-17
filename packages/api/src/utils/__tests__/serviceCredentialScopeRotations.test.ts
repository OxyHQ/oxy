import {
  findRegisteredScopeRotation,
  hasExactRegisteredScopes,
  isRegisteredScopeRotation,
} from "../serviceCredentialScopeRotations";

const HOMIIO = "6a2f851751b784a86fd0e922";
const ALIA = "6a2f851751b784a86fd0e934";

const homiioLane = {
  applicationId: HOMIIO,
  environment: "production",
  credentialName: "Service (production)",
  scopes: ["inference:invoke", "reputation:write"],
};

describe("service credential scope rotation registry", () => {
  it("registers exactly the reviewed Alia and Homiio lanes", () => {
    expect(findRegisteredScopeRotation(ALIA)?.credentialName).toBe(
      "Oxy service (production)",
    );
    expect(findRegisteredScopeRotation(HOMIIO)?.credentialName).toBe(
      "Service (production)",
    );
    expect(findRegisteredScopeRotation("68b7c4e19f2a6d0e3c8b5174")).toBeUndefined();
    expect(findRegisteredScopeRotation(undefined)).toBeUndefined();
    expect(findRegisteredScopeRotation(` ${HOMIIO}`)).toBeUndefined();
  });

  it("accepts Homiio's exact service lane in any scope order", () => {
    expect(isRegisteredScopeRotation(homiioLane)).toBe(true);
  });

  it.each([
    ["another environment", { environment: "staging" }],
    ["the activity credential name", { credentialName: "Ecosystem activity (production)" }],
    ["broader scopes", { scopes: ["reputation:write", "inference:invoke", "user:read"] }],
    ["narrower scopes", { scopes: ["reputation:write"] }],
    ["another lane's name", { credentialName: "Oxy service (production)" }],
  ])("refuses Homiio rotation with %s", (_label, override) => {
    expect(isRegisteredScopeRotation({ ...homiioLane, ...override })).toBe(false);
  });

  it("does not let one application borrow another's registered lane", () => {
    expect(
      isRegisteredScopeRotation({
        applicationId: ALIA,
        environment: "production",
        credentialName: "Service (production)",
        scopes: ["reputation:write", "inference:invoke"],
      }),
    ).toBe(false);
  });

  it("treats duplicate scopes as a different set", () => {
    expect(
      hasExactRegisteredScopes(
        ["reputation:write", "reputation:write"],
        ["reputation:write", "inference:invoke"],
      ),
    ).toBe(false);
  });
});
