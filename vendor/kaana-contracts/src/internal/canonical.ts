/**
 * Canonical JSON and the canonical input hash.
 *
 * Operations with a source approval (scoped execution, Private Auto, the Jev
 * classifier) bind the exact input they were approved for. Kaana computes the
 * hash of the input it is about to execute and Oxy compares it with the one
 * the approval fixed (Kaana ADR 0002, decision 4), so both sides must hash the
 * same bytes. This is that one definition.
 *
 * `canonicalJson` is moved from `@oxy.so/contracts` 4.12.0
 * (`canonicalScopedExecutionJson`, `src/inference/scopedExecution.ts`), and Go
 * restates it in `internal/contract/scoped_execution.go`.
 */

/**
 * Canonical JSON wire bytes: recursive UTF-16 key order, JSON string/number
 * encoding, arrays in order, no whitespace. Hash the whole signed input, not a
 * reparsed/defaulted decision. Reject non-JSON values rather than dropping them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries = Array.from(value, (entry, index) => {
      if (!(index in value)) throw new Error('Canonical JSON requires dense JSON arrays.');
      return canonicalJson(entry);
    });
    return `[${entries.join(',')}]`;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  throw new Error('Canonical JSON requires JSON wire values.');
}

/** The name scoped execution has always used for {@link canonicalJson}. */
export const canonicalScopedExecutionJson = canonicalJson;

/**
 * The canonical input hash: lowercase hex SHA-256 of {@link canonicalJson} of
 * the request input, UTF-8 encoded.
 *
 * Asynchronous because it uses Web Crypto, which every runtime this package
 * supports (Node 20+, Bun, browsers, Hermes with a crypto polyfill) provides
 * without importing a platform module. Never logged or persisted: it binds
 * transient signed bytes.
 */
export async function canonicalInputSha256(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
