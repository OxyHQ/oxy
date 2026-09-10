/**
 * Canonical JSON (RFC 8785 / JCS-style) serialization.
 *
 * `canonicalize(value)` produces a deterministic string for any JSON-compatible
 * value so that a client which SIGNS a record and a server which VERIFIES it
 * agree byte-for-byte on the signing input — regardless of the order in which
 * object keys happen to be written, how the value was deserialized, or which
 * runtime built it.
 *
 * This is the load-bearing primitive for the protocol's signed records
 * (`signEnvelope` + `verifyEnvelopeSignature`): every implementation imports
 * THIS function from `@oxy.so/protocol`, so cross-implementation number/string
 * formatting differences cannot cause a verify mismatch.
 *
 * Rules (the JSON Canonicalization Scheme subset we need):
 *  - Objects: keys are sorted (ascending, by UTF-16 code unit — the default
 *    `Array.prototype.sort` order) and serialized recursively. Properties whose
 *    value is `undefined`, a function, or a symbol are OMITTED (matching
 *    `JSON.stringify` object semantics).
 *  - Arrays: element order is PRESERVED; `undefined`/function/symbol elements
 *    serialize to `null` (matching `JSON.stringify` array semantics).
 *  - `null`, booleans, strings, and finite numbers serialize via the standard
 *    JSON representation.
 *  - Values exposing a `toJSON()` method (e.g. `Date`) are replaced by its
 *    result first, then serialized — so a `Date` and its ISO-string equivalent
 *    canonicalize identically (the wire always carries the string form).
 *  - Non-finite numbers (`NaN`, `Infinity`) and `bigint` are not part of the
 *    JSON data model and throw, rather than silently producing `null`.
 *
 * Platform-agnostic — zero dependencies, no `require()`, no react/react-native/
 * expo. Safe in the dual CJS + ESM build.
 */

/** Object exposing a `toJSON()` serialization hook (e.g. `Date`). */
interface ToJsonable {
  toJSON: () => unknown;
}

function hasToJSON(value: object): value is ToJsonable {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

/**
 * Serialize a single value into its canonical JSON fragment. Recursive; called
 * on each nested member. Object keys are sorted at every level.
 */
function serialize(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const valueType = typeof value;

  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalize: non-finite numbers cannot be serialized');
    }
    return JSON.stringify(value);
  }

  if (valueType === 'string' || valueType === 'boolean') {
    return JSON.stringify(value);
  }

  if (valueType === 'bigint') {
    throw new Error('canonicalize: bigint values cannot be serialized');
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const itemType = typeof item;
      // JSON array semantics: undefined / function / symbol become null so the
      // element positions (and therefore the array length) are preserved.
      if (item === undefined || itemType === 'function' || itemType === 'symbol') {
        return 'null';
      }
      return serialize(item);
    });
    return `[${items.join(',')}]`;
  }

  if (valueType === 'object') {
    const obj = value as object;
    if (hasToJSON(obj)) {
      return serialize(obj.toJSON());
    }

    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      const memberType = typeof member;
      // JSON object semantics: properties with undefined / function / symbol
      // values are omitted entirely.
      if (member === undefined || memberType === 'function' || memberType === 'symbol') {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${serialize(member)}`);
    }
    return `{${parts.join(',')}}`;
  }

  // undefined / function / symbol at the top level have no JSON representation.
  throw new Error(`canonicalize: cannot serialize a value of type ${valueType}`);
}

/**
 * Produce the canonical JSON string for `value`.
 *
 * Deterministic: two structurally-equal values yield identical strings even if
 * their object keys were written in different orders. Use this — never an
 * ad-hoc `JSON.stringify` of a hand-sorted object — as the signing input for
 * signed records, so client signing and server verification cannot drift.
 *
 * @throws if `value` (or any nested member used as the top-level/primitive)
 *   contains a non-finite number or a `bigint`, which have no JSON form.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}
