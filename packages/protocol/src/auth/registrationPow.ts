/**
 * Registration proof-of-work — the message format and difficulty check a
 * signup grinds a nonce against, shared verbatim between the client (which
 * SOLVES it) and the server (which CHECKS it).
 *
 * ## Why this exists
 *
 * `POST /auth/register` mints an account from nothing more than a freshly
 * generated secp256k1 keypair and a signature over
 * `oxy:register:{publicKey}:{timestamp}` — computationally free. A PoW nonce
 * makes each account cost a small, real amount of CPU time to mint, without
 * asking a real signer for anything beyond what they already do locally: no
 * server round trip, no third-party CAPTCHA, no extra user-visible step.
 *
 * ## Single source, on purpose
 *
 * The client must SOLVE the exact message the server CHECKS, so the message
 * format and the difficulty threshold live here once, in a package both
 * `@oxy.so/core` (the client SDK) and the API already depend on for
 * secp256k1 — see `packages/contracts/src/username.ts`'s docblock for why
 * this codebase treats "the same rule declared twice" as a bug class, not a
 * style preference. This file is deliberately CRYPTO-FREE: it is pure
 * string/bit arithmetic over a caller-supplied hex digest, so it needs no
 * platform hashing primitive and is trivially unit-testable with fixed
 * digests. Each side hashes with whatever SHA-256 it already has — Node's
 * `crypto` server-side (`packages/api/src/controllers/session.controller.ts`),
 * `@noble/hashes/sha256` client-side (`packages/core/src/crypto/registrationPow.ts`,
 * already a `@oxy.so/core` dependency — see `crypto/kdf.ts`,
 * `crypto/identityProof.ts`) — and both produce byte-identical digests over
 * the same message, because SHA-256 has exactly one correct output for a
 * given input regardless of implementation.
 *
 * ## What this is NOT
 *
 * Not a defense against a targeted, patient attacker: nothing stops one from
 * choosing their OWN `timestamp` a few minutes in the future and grinding the
 * nonce ahead of time, banking a queue of pre-solved (timestamp, nonce) pairs
 * to spend inside the 5-minute signature freshness window
 * (`SignatureService.isTimestampFresh` / `MAX_SIGNATURE_AGE_MS`). Closing that
 * needs a server-issued, single-use challenge — a real round trip and server
 * state this deliberately does not add, because the goal here is raising the
 * COST of unattended bulk signup, not proving liveness. Combined with a
 * per-IP rate limit on `/auth/register`, it still meaningfully raises the
 * price of automated mass account creation over today's zero-cost baseline.
 *
 * ## Rollout: advisory only, for now
 *
 * `POST /auth/register`'s `powNonce` field is OPTIONAL on the wire and the
 * server does not yet reject a missing or failing one — see the comment at
 * the check site in `packages/api/src/controllers/session.controller.ts` for
 * why (every Oxy app consumes the SDK as a published package, not this
 * monorepo live, so hard-enforcing before every app has picked up a client
 * new enough to send it would break their signup outright) and exactly what
 * to change to flip it to a hard 400.
 */

/**
 * Leading zero BITS contributed by one lowercase hex nibble.
 *
 * A hex digit is 4 bits: `'0'` contributes all 4, `'8'`–`'f'` (binary `1xxx`)
 * contribute none because their own leading bit is already `1`. Spelled out
 * as a table rather than derived with `Math.clz32` so the mapping is checkable
 * by eye against the difficulty this gates.
 */
const NIBBLE_LEADING_ZERO_BITS: Readonly<Record<string, number>> = {
  '0': 4,
  '1': 3,
  '2': 2,
  '3': 2,
  '4': 1,
  '5': 1,
  '6': 1,
  '7': 1,
  '8': 0,
  '9': 0,
  a: 0,
  b: 0,
  c: 0,
  d: 0,
  e: 0,
  f: 0,
};

/**
 * The message a registration PoW nonce is grinded against, given the same
 * `publicKey`/`timestamp` the registration signature (`oxy:register:…`)
 * already commits to. A distinct prefix (`register-pow`, not `register`) so a
 * solved PoW nonce can never be replayed as a registration signature input or
 * vice versa — the two are unrelated preimages even for the same
 * `publicKey`/`timestamp` pair.
 */
export function registrationPowMessage(publicKey: string, timestamp: number, nonce: string): string {
  return `oxy:register-pow:${publicKey}:${timestamp}:${nonce}`;
}

/**
 * The number of leading zero bits {@link meetsRegistrationPowDifficulty}
 * requires of a solved nonce's digest.
 *
 * 16 bits ⇒ 65,536 SHA-256 attempts on average to solve. The client grinds
 * with `@noble/hashes/sha256` — a pure-JS, SYNCHRONOUS implementation with
 * "identical behaviour on web, Node, and React Native with zero WebCrypto /
 * native-module dependency" (its own doc comment in `crypto/kdf.ts`) — so,
 * unlike a solve loop built on a platform hashing primitive that crosses a
 * JS↔native bridge per call (`expo-crypto`'s `digestStringAsync`, which this
 * deliberately avoids for exactly that reason), there is no per-attempt
 * bridge cost to budget for. The remaining uncertainty is Hermes' lack of a
 * JIT, which can make a tight pure-JS loop meaningfully slower than V8 — 16
 * bits is chosen to stay a sub-second grind even under that penalty, without
 * reaching for a bound high enough to make Hermes specifically the deciding
 * factor. Retune this constant (it is the only place the number is declared)
 * once there is real on-device telemetry across the low end of the supported
 * device range.
 */
export const REGISTRATION_POW_DIFFICULTY_BITS = 16;

/**
 * Count the leading zero BITS of a lowercase hex digest.
 *
 * Stops at the first non-zero nibble — a solved nonce only ever needs to beat
 * a bound in the tens of bits, so scanning the full 256-bit digest is wasted
 * work. A character outside `[0-9a-f]` (not a real digest — a caller passed
 * something malformed) stops the count where it is rather than throwing: the
 * caller compares the result against a difficulty, and an under-count from bad
 * input correctly fails that comparison instead of crashing a request path.
 */
export function countLeadingZeroBits(hexDigest: string): number {
  let bits = 0;
  for (const char of hexDigest.toLowerCase()) {
    const nibbleZeroBits = NIBBLE_LEADING_ZERO_BITS[char];
    if (nibbleZeroBits === undefined) break;
    bits += nibbleZeroBits;
    if (nibbleZeroBits < 4) break;
  }
  return bits;
}

/**
 * Whether a SHA-256 hex digest — of {@link registrationPowMessage} — clears
 * `difficultyBits` leading zero bits. The one predicate both the client's
 * solve loop and the server's check call, so neither can drift from what
 * "solved" means.
 */
export function meetsRegistrationPowDifficulty(hexDigest: string, difficultyBits: number): boolean {
  return countLeadingZeroBits(hexDigest) >= difficultyBits;
}
