/**
 * Canonical JSON tests.
 *
 * The whole point of `canonicalize` is that two structurally-equal values
 * produce identical strings regardless of how their keys were ordered, so a
 * client which signs and a server which verifies agree on the signing input.
 * These tests pin that determinism, the array-order guarantee, the nesting
 * behaviour, and the JSON value/omit semantics.
 */

import { canonicalize } from '../envelope/canonicalJson';

describe('canonicalize', () => {
  describe('object key ordering', () => {
    it('produces identical output regardless of insertion order', () => {
      const a = canonicalize({ b: 1, a: 2, c: 3 });
      const b = canonicalize({ c: 3, a: 2, b: 1 });
      const c = canonicalize({ a: 2, b: 1, c: 3 });
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a).toBe('{"a":2,"b":1,"c":3}');
    });

    it('sorts keys recursively at every level', () => {
      const value = {
        z: { y: 1, x: 2 },
        a: { c: 3, b: { e: 5, d: 4 } },
      };
      expect(canonicalize(value)).toBe('{"a":{"b":{"d":4,"e":5},"c":3},"z":{"x":2,"y":1}}');
    });

    it('is order-insensitive across deep nesting', () => {
      const first = canonicalize({
        outer: { inner: { p: 1, q: 2 }, lead: 'x' },
        meta: { issuedAt: 10, version: 1 },
      });
      const second = canonicalize({
        meta: { version: 1, issuedAt: 10 },
        outer: { lead: 'x', inner: { q: 2, p: 1 } },
      });
      expect(first).toBe(second);
    });
  });

  describe('array ordering', () => {
    it('preserves array element order (never sorts arrays)', () => {
      expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
      expect(canonicalize(['b', 'a', 'c'])).toBe('["b","a","c"]');
    });

    it('distinguishes arrays that differ only in order', () => {
      expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    });

    it('canonicalizes objects inside arrays without reordering the array', () => {
      const value = [
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ];
      expect(canonicalize(value)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
    });
  });

  describe('primitives', () => {
    it('serializes null, booleans, strings and numbers as JSON', () => {
      expect(canonicalize(null)).toBe('null');
      expect(canonicalize(true)).toBe('true');
      expect(canonicalize(false)).toBe('false');
      expect(canonicalize('hi')).toBe('"hi"');
      expect(canonicalize(42)).toBe('42');
      expect(canonicalize(-1.5)).toBe('-1.5');
      expect(canonicalize(0)).toBe('0');
    });

    it('escapes strings the same way JSON does', () => {
      expect(canonicalize('a"b\\c\n')).toBe(JSON.stringify('a"b\\c\n'));
    });
  });

  describe('JSON value/omit semantics', () => {
    it('omits object properties whose value is undefined', () => {
      expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    });

    it('renders undefined array elements as null (preserving length)', () => {
      expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
    });

    it('respects toJSON (Date and its ISO string canonicalize identically)', () => {
      const date = new Date('2026-06-26T00:00:00.000Z');
      expect(canonicalize(date)).toBe(JSON.stringify(date.toISOString()));
      expect(canonicalize({ at: date })).toBe(canonicalize({ at: '2026-06-26T00:00:00.000Z' }));
    });
  });

  describe('rejects values outside the JSON data model', () => {
    it('throws on non-finite numbers', () => {
      expect(() => canonicalize(Number.NaN)).toThrow();
      expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
      expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow();
    });

    it('throws on bigint', () => {
      expect(() => canonicalize(BigInt(1))).toThrow();
    });

    it('throws on a bare undefined / function at the top level', () => {
      expect(() => canonicalize(undefined)).toThrow();
      expect(() => canonicalize(() => 1)).toThrow();
    });
  });
});
