import { stripSensitiveUrlQueryParams } from "../sanitizeUrl";

describe("stripSensitiveUrlQueryParams", () => {
  it("removes every credential-bearing parameter while preserving path, safe query and fragment", () => {
    expect(
      stripSensitiveUrlQueryParams(
        "https://cdn.example.test/icons/homiio.svg?size=64&token=secret-marker&theme=dark&access_token=another&authorization=third#logo",
      ),
    ).toBe("https://cdn.example.test/icons/homiio.svg?size=64&theme=dark#logo");
  });

  it("covers relative asset references and case or percent-encoded parameter names", () => {
    expect(
      stripSensitiveUrlQueryParams(
        "/assets/icon.svg?Token=one&%61ccess_token=two&AUTHORIZATION=three&v=4",
      ),
    ).toBe("/assets/icon.svg?v=4");
  });

  it("does not interpret a fragment label as a query string", () => {
    const value =
      "https://cdn.example.test/icon.svg?size=64#preview?token=not-a-query-param";
    expect(stripSensitiveUrlQueryParams(value)).toBe(value);
  });

  it("returns a clean value byte-for-byte and is idempotent", () => {
    const value = "asset-icon-id?size=64&theme=dark#logo";
    expect(stripSensitiveUrlQueryParams(value)).toBe(value);
    expect(
      stripSensitiveUrlQueryParams(stripSensitiveUrlQueryParams(value)),
    ).toBe(value);
  });
});
