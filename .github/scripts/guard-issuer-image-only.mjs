/** Source-only guard. No AWS, secret lookup or caller-controlled baseline. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readCommittedPolicyStatus } from '../../scripts/forge-audit-policy.mjs';
const BASE = '4b145040afca38be93ad4096241d4c60e12e1c82';
const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
const EXPECTED = [
  'packages/api/openapi.json',
  'packages/api/src/routes/__tests__/serviceTokenCredentials.test.ts',
  'packages/api/src/routes/auth.ts',
  'packages/api/src/services/__tests__/workloadIdentity.db.test.ts',
  'packages/api/src/services/serviceTokenMint.service.ts',
].sort();
export function validateIssuerSource({
  event,
  ref,
  policyStatus,
  manifest,
  paths,
  committed,
  working,
  ddlPaths,
}) {
  requireValue(
    event === 'workflow_dispatch' && ref === 'refs/heads/main',
    'Image-only stage requires manual protected-main dispatch',
  );
  requireValue(policyStatus === 'ACTIVE', 'Active exact Forge source/image policy required');
  requireValue(manifest.base === BASE, 'Fixed issuer baseline required');
  requireValue(
    JSON.stringify(Object.keys(manifest.packages).sort()) === JSON.stringify(EXPECTED),
    'Exact reviewed five issuer paths required',
  );
  requireValue(
    JSON.stringify([...paths].sort()) === JSON.stringify(EXPECTED),
    'Runtime package delta differs from exact issuer stage',
  );
  for (const path of EXPECTED) {
    requireValue(
      digest(committed(path)) === manifest.packages[path],
      `Issuer input mismatch: ${path}`,
    );
    requireValue(
      digest(working(path)) === manifest.packages[path],
      `Working input mismatch: ${path}`,
    );
  }
  for (const path of ['package.json', 'bun.lock', 'Dockerfile']) {
    requireValue(
      digest(committed(path)) === manifest.root[path],
      `Materialization input mismatch: ${path}`,
    );
    requireValue(
      digest(working(path)) === manifest.root[path],
      `Working materialization mismatch: ${path}`,
    );
  }
  requireValue(ddlPaths.length === 0, 'Issuer stage cannot change DDL');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = 'docs/audits/2026-10-03-service-token-issuer-stage/runtime-inputs.json';
  validateIssuerSource({
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    policyStatus: readCommittedPolicyStatus(),
    manifest: JSON.parse(git('show', `HEAD:${manifestPath}`)),
    paths: git('diff', '--name-only', BASE, 'HEAD', '--', 'packages')
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean),
    committed: (path) => git('show', `HEAD:${path}`),
    working: (path) => readFileSync(path),
    ddlPaths: git('diff', '--name-only', BASE, 'HEAD', '--', 'packages/api/drizzle')
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean),
  });
  console.log(
    'Exact issuer-only package/root inputs and active source policy checked; no production action.',
  );
}
