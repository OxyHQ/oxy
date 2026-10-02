// Candidate byte/regression evidence only: never approves security policy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { inventory, inventoryHash, sha256, FILES, ARM_PRUNING_RECEIPT } from './forge-remediation-proof-proposal.mjs';
const [installedRoot, manifestPath, regressionPath, patchPath] = process.argv.slice(2);
assert.ok(patchPath, 'Usage: ROOT HASH_MANIFEST REGRESSION_SCRIPT PATCH');
const manifest = JSON.parse(readFileSync(manifestPath));
assert.equal(manifest.status, 'CANDIDATE_UNAPPROVED');
assert.equal(sha256(readFileSync(patchPath)), manifest.patchSha256, 'Candidate patch changed');
if (manifest.intentionalDanglingSharpLinks?.length) assert.deepEqual(manifest.pruningReceipt, ARM_PRUNING_RECEIPT, 'Earlier ARM pruning receipt changed');
const copies = inventory(resolve(installedRoot), { intentionalDanglingSharpLinks: manifest.intentionalDanglingSharpLinks ?? [] });
assert.ok(copies.length > 0, 'No materialized Forge copies');
const regressions = [];
for (const copy of copies) {
  assert.equal(copy.version, '1.4.0', 'Version must remain truthful');
  for (const file of FILES) assert.equal(copy.files[file], manifest.files[file].candidateSha256, `Unpatched ${file} at ${copy.realpath}`);
  const report = JSON.parse(execFileSync(process.execPath, [resolve(regressionPath), copy.realpath, 'candidate'], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
  assert.equal(report.count, 321, 'Complete regression set required');
  assert.equal(report.knownKeyControlsOnly, true);
  regressions.push({ realpath: copy.realpath, node: report.node, openssl: report.openssl, count: report.count, publicKeySha256: report.publicKeySha256, reportSha256: sha256(JSON.stringify(report)), rows: report.rows });
}
console.log(JSON.stringify({ candidateOnly: true, approved: false, technicalByteRegressionProofPassed: true, platform: process.platform, arch: process.arch, node: process.version, installedRoot: resolve(installedRoot), patchSha256: manifest.patchSha256, earlierPruningReceipt: manifest.pruningReceipt, inventorySha256: inventoryHash(copies), intentionalDanglingSharpLinks: copies.intentionalDanglingSharpLinks, copies, regressions }, null, 2));
