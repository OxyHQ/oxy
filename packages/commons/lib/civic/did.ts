/**
 * DID helpers for the Commons civic surface.
 *
 * An Oxy user's DID anchors the stable account id after the `:u:` segment:
 *
 *   did:web:<apex>:u:<userId>   (e.g. `did:web:oxy.so:u:65f0…`)
 *
 * The Oxy ID QR encodes ONLY this DID (`oxycommons://card?did=…`), so the scanner
 * must recover the `userId` from it before resolving the signed public card via
 * `oxyServices.getPublicCard(userId)`. `@oxy.so/core` owns the inverse
 * (`buildUserDid`); the parser lives here because the scanner is a Commons-only
 * concern. Pure + dependency-free (Hermes / jsdom safe — no `URL` global).
 */

/** Prefix every Oxy `did:web` is built on. */
const DID_WEB_PREFIX = 'did:web:';

/** Segment that introduces the stable account id inside the DID path. */
const USER_SEGMENT = ':u:';

/**
 * Extract the stable `userId` from an Oxy DID (`did:web:<apex>:u:<userId>`).
 *
 * @param did - The DID string (exactly as carried in an Oxy ID payload).
 * @returns The `userId` when the DID is a well-formed Oxy `did:web` with a
 *   non-empty user segment; `null` for anything else (wrong method, missing
 *   `:u:` segment, empty/malformed id, or non-string input).
 */
export function userIdFromDid(did: string): string | null {
  if (typeof did !== 'string') return null;
  const trimmed = did.trim();
  if (!trimmed.startsWith(DID_WEB_PREFIX)) return null;

  const idx = trimmed.indexOf(USER_SEGMENT);
  if (idx < 0) return null;

  const userId = trimmed.slice(idx + USER_SEGMENT.length);
  // A real account id (Mongo `_id`) carries no `/`, `:`, `?` or `#`; reject a
  // trailing path/fragment or an empty tail rather than resolving a bogus id.
  if (userId.length === 0 || /[/:?#]/.test(userId)) return null;
  return userId;
}
