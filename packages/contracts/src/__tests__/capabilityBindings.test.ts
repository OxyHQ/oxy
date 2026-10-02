import { canonicalCapabilityJson, inputSatisfiesCapabilityLimits, isLoopbackOrigin } from '../capabilityBindings';

it('matches registry JSON for key order and optional undefined properties', () => {
  expect(canonicalCapabilityJson({ z: [{ b: undefined, c: 1 }], a: 2, missing: undefined }))
    .toBe(canonicalCapabilityJson({ a: 2, z: [{ c: 1 }] }));
  expect(canonicalCapabilityJson({ value: [undefined, 2] })).toBe('{"value":[null,2]}');
});

it('includes own __proto__ and constructor JSON keys without invoking object setters', () => {
  const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}},"type":"object"}');
  expect(canonicalCapabilityJson(schema)).toBe('{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}},"type":"object"}');
  expect(Object.prototype).not.toHaveProperty('type');
});

it('retains numeric/boolean nested-array limits and rejects missing, nonfinite or different tool inputs', () => {
  const limits = [{ tool: 'write', key: 'rows.amount', value: 10 }, { tool: 'write', key: 'confirmed', value: true }];
  expect(inputSatisfiesCapabilityLimits('write', { rows: [{ amount: 8 }, { amount: 10 }], confirmed: true }, limits)).toBe(true);
  for (const rows of [[{ amount: 11 }], [{ amount: Number.NaN }], [{}]]) {
    expect(inputSatisfiesCapabilityLimits('write', { rows, confirmed: true }, limits)).toBe(false);
  }
  expect(inputSatisfiesCapabilityLimits('read', { rows: [{ amount: 8 }], confirmed: true }, limits)).toBe(false);
});

it('keeps the existing exact loopback host/protocol set', () => {
  for (const origin of ['http://localhost:8080', 'https://127.0.0.1', 'http://[::1]:1234']) expect(isLoopbackOrigin(origin)).toBe(true);
  for (const origin of ['http://localhost.evil', 'http://127.0.0.2', 'ftp://localhost', 'invalid']) expect(isLoopbackOrigin(origin)).toBe(false);
});
