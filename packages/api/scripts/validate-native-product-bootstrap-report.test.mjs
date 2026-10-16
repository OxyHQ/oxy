import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateBootstrapReport } from './validate-native-product-bootstrap-report.mjs';
const plan = () => ({
  after: {},
  aliaManifest: {},
  before: {},
  desired: {},
  direction: 'bootstrap',
  manifestVersion: 1,
  operations: [],
});
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;
function report(p = plan()) {
  return {
    mode: 'dry-run',
    direction: 'bootstrap',
    planSha256: createHash('sha256')
      .update(JSON.stringify(canonical(p)))
      .digest('hex'),
    plan: p,
  };
}
const line = (r) => `NATIVE_PRODUCT_AGENTS_RESULT=${JSON.stringify(r)}`;
test('returns the complete exact plan, including reviewed scope and webhook changes', () => {
  const p = plan();
  p.before = { scopes: ['user:read'], webhookUrl: null };
  p.after = {
    scopes: ['user:read', 'organizations:import'],
    webhookUrl: 'https://api.clarity.surf/webhooks/oxy/account-events',
  };
  p.operations = ['grant worker import scope'];
  assert.deepEqual(validateBootstrapReport(line(report(p))).plan, p);
});
test('rejects hash-only success, changed evidence, unrecognized envelope fields and oversized input', () => {
  const r = report();
  assert.throws(() => validateBootstrapReport(line({ ...r, plan: undefined })));
  assert.throws(() =>
    validateBootstrapReport(line({ ...r, plan: { ...r.plan, operations: ['different'] } })),
  );
  assert.throws(() => validateBootstrapReport(line({ ...r, secret: 'forbidden' })));
  assert.throws(() => validateBootstrapReport('x'.repeat(262145)));
});
for (const key of [
  'secretHash',
  'apiSecret',
  'accessToken',
  'refresh_token',
  'privateKey',
  'password',
  'cookie',
])
  test(`rejects nested ${key} even with a valid hash`, () => {
    const p = plan();
    p.before = { credential: { [key]: 'must-not-cross' } };
    assert.throws(() => validateBootstrapReport(line(report(p))));
  });
