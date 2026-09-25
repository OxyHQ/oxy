import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { identityOriginHeaders, resolveApiOrigin } from './headers.mjs';

const directives = (csp) => Object.fromEntries(csp.split('; ').map((part) => {
  const [name, ...values] = part.split(' ');
  return [name, values];
}));

test('the policy allows first-party code and the Oxy API, and nothing else', () => {
  const csp = directives(identityOriginHeaders({ apiOrigin: 'https://api.oxy.so' })['Content-Security-Policy']);
  assert.deepEqual(csp['default-src'], ["'none'"]);
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.deepEqual(csp['style-src'], ["'self'"]);
  assert.deepEqual(csp['connect-src'], ["'self'", 'https://api.oxy.so']);
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'none'"]);
  for (const [name, values] of Object.entries(csp)) {
    for (const value of values) {
      assert.ok(!value.includes('unsafe'), `${name} must not allow ${value}`);
      assert.ok(!value.includes('*'), `${name} must not use a wildcard`);
    }
  }
});

test('the popup relationship is kept: no Cross-Origin-Opener-Policy', () => {
  assert.equal(identityOriginHeaders({ apiOrigin: 'https://api.oxy.so' })['Cross-Origin-Opener-Policy'], undefined);
});

test('only a bare https API origin (or loopback http) is accepted', () => {
  assert.equal(resolveApiOrigin(undefined), 'https://api.oxy.so');
  assert.equal(resolveApiOrigin('http://localhost:3001'), 'http://localhost:3001');
  for (const bad of ['http://api.oxy.so', 'https://api.oxy.so/v1', 'https://user:pass@api.oxy.so', 'https://api.oxy.so?x=1']) {
    assert.throws(() => resolveApiOrigin(bad));
  }
});

test('every asset response carries the headers, body and status intact', async () => {
  const env = { OXY_API_ORIGIN: 'https://api.oxy.so', ASSETS: { fetch: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }) } };
  const response = await worker.fetch(new Request('https://id.oxy.so/'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(await response.text(), '<!doctype html>');
});

test('every response is no-transform, so the edge never injects the Insights beacon', async () => {
  const assets = (headers) => ({ OXY_API_ORIGIN: 'https://api.oxy.so', ASSETS: { fetch: async () => new Response('x', { headers }) } });
  const cached = await worker.fetch(new Request('https://id.oxy.so/'), assets({ 'cache-control': 'public, max-age=0, must-revalidate' }));
  assert.equal(cached.headers.get('cache-control'), 'public, max-age=0, must-revalidate, no-transform');
  const bare = await worker.fetch(new Request('https://id.oxy.so/'), assets({}));
  assert.equal(bare.headers.get('cache-control'), 'no-transform');
});
