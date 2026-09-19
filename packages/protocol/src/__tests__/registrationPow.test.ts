import {
  countLeadingZeroBits,
  meetsRegistrationPowDifficulty,
  registrationPowMessage,
  REGISTRATION_POW_DIFFICULTY_BITS,
} from "../auth/registrationPow";

describe("registrationPowMessage", () => {
  test("binds publicKey, timestamp and nonce, distinct from the registration signature message", () => {
    expect(registrationPowMessage("pk", 1700000000000, "42")).toBe(
      "oxy:register-pow:pk:1700000000000:42",
    );
  });

  test("a different nonce is a different message", () => {
    expect(registrationPowMessage("pk", 1, "a")).not.toBe(
      registrationPowMessage("pk", 1, "b"),
    );
  });
});

describe("countLeadingZeroBits", () => {
  test.each([
    ["", 0],
    ["f", 0],
    ["8000", 0],
    ["0", 4],
    ["00", 8],
    ["01", 7],
    ["0f", 4],
    ["1f", 3],
    ["2f", 2],
    ["4f", 1],
    ["0000f", 16],
    // Case-insensitive: the digest producers this compares against are
    // lowercase, but the counter must not silently under-count an uppercase one.
    ["00F", 8],
  ])("counts %s as %i leading zero bits", (hex, expected) => {
    expect(countLeadingZeroBits(hex)).toBe(expected);
  });

  test("stops at the first non-zero nibble rather than scanning the whole digest", () => {
    expect(countLeadingZeroBits(`00f${"0".repeat(60)}`)).toBe(8);
  });

  test("a non-hex character ends the count instead of throwing", () => {
    expect(countLeadingZeroBits("0z")).toBe(4);
    expect(() => countLeadingZeroBits("not-hex-at-all")).not.toThrow();
  });
});

describe("meetsRegistrationPowDifficulty", () => {
  test("passes a digest that clears the bound", () => {
    expect(meetsRegistrationPowDifficulty("00f0", 8)).toBe(true);
    expect(meetsRegistrationPowDifficulty("00f0", 9)).toBe(false);
  });

  test("an exact match at the bound passes", () => {
    expect(meetsRegistrationPowDifficulty("00f0", 8)).toBe(true);
  });

  test("the exported difficulty constant is a defensible, positive bound", () => {
    // Pinned as a regression check on the constant itself: a change here is a
    // deliberate retune, not an accidental one, and shows up in review.
    expect(REGISTRATION_POW_DIFFICULTY_BITS).toBe(16);
    expect(meetsRegistrationPowDifficulty("0".repeat(64), REGISTRATION_POW_DIFFICULTY_BITS)).toBe(
      true,
    );
    expect(meetsRegistrationPowDifficulty("f".repeat(64), REGISTRATION_POW_DIFFICULTY_BITS)).toBe(
      false,
    );
  });
});
