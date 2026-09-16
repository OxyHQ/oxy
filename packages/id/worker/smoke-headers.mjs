/**
 * Post-deploy gate: the LIVE id.oxy.so serves the app with the identity-origin
 * header policy. A deploy that lost the Worker (assets served without it) would
 * still render — and would unseal identities with no CSP. This is what says so.
 *
 * Usage: SMOKE_TARGET=https://id.oxy.so node worker/smoke-headers.mjs
 */
import { identityOriginHeaders } from './headers.mjs';

const target = process.env.SMOKE_TARGET ?? 'https://id.oxy.so';
const expected = identityOriginHeaders({ apiOrigin: 'https://api.oxy.so' });

const response = await fetch(`${target}/`, { redirect: 'manual' });
const failures = [];
if (response.status !== 200) failures.push(`status ${response.status}`);
for (const [name, value] of Object.entries(expected)) {
  const actual = response.headers.get(name);
  if (actual !== value) failures.push(`${name}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`);
}
if (!(await response.text()).includes('id="root"')) failures.push('the app shell is missing');

if (failures.length > 0) {
  console.error(`id.oxy.so header smoke FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`id.oxy.so serves the identity-origin header policy (${Object.keys(expected).length} headers).`);
