/**
 * The one search a leak assertion uses to ask "did this credential get out?"
 *
 * Lives here rather than beside either of its callers because two suites assert
 * with it and one of them is the MUTATION TEST for the other
 * (`__tests__/inferenceProviderConnection.service.test.ts` and
 * `__tests__/providerCredentialLeak.test.ts`, issue #972 workstream 10). A mutation
 * test that carried its own copy would prove a recursive walk catches the leaks
 * it plants and nothing about the walk the assertions actually run — the two
 * would be free to drift, and the drift would be invisible because both files
 * would stay green.
 *
 * `packages/api`'s jest config treats EVERY `.ts` file under a `__tests__`
 * directory as a suite, so a shared probe cannot live there; `src/db/testDatabase.ts`
 * is the same shape and the precedent for this placement.
 */

/**
 * Does `haystack`, walked to every leaf, contain `needle` anywhere?
 *
 * Recursive rather than `JSON.stringify(haystack).includes(needle)`, because a
 * leaf that redacts itself on the way OUT — a plain object with a `toJSON`, which
 * is what a half-finished redaction looks like — serialises clean while still
 * holding the bytes. The two are used together in the assertions: this one sees
 * through a `toJSON`, and the serialised form sees what a route actually writes
 * to the socket. `providerCredentialLeak.test.ts` plants a leak only one of them
 * catches, so neither is decorative.
 *
 * Three things it CANNOT see, measured in that file rather than assumed:
 *
 *  - A `#private` field. `ProviderCredentialValue` holds plaintext in one, so an
 *    instance of it is invisible to this walk AND to `JSON.stringify`. What keeps
 *    that from being a hole is the contract's `.strict()`, which gives such a
 *    value no field to sit in — not this function.
 *  - The contents of a `Map`, a `Set` or a symbol-keyed property, none of which
 *    `Object.values` enumerates. Nothing in these DTOs, rows or audit events is
 *    one; a caller that changes must extend this rather than assume coverage.
 *  - A credential that was transformed on the way out (encoded, hashed, split).
 *    This answers "are these exact bytes present", which is the question a leak
 *    assertion should ask — an approximate one would go red on a fingerprint.
 */
export function containsDeep(haystack: unknown, needle: string): boolean {
  if (typeof haystack === 'string') return haystack.includes(needle);
  if (haystack === null || typeof haystack !== 'object') return false;
  if (Array.isArray(haystack)) return haystack.some((item) => containsDeep(item, needle));
  return Object.values(haystack as Record<string, unknown>).some((value) =>
    containsDeep(value, needle)
  );
}
