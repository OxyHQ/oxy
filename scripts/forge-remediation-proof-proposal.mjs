/** INERT proposal. Never substitutes for the dependency audit or grants approval. */
import { readFileSync, readdirSync, realpathSync, readlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const ADVISORY = 'GHSA-86w9-cpqp-85rv';
export const FILES = ['lib/rsa.js', 'dist/forge.min.js', 'dist/forge.min.js.map', 'dist/forge.all.min.js', 'dist/forge.all.min.js.map'];
export const SUITES = ['rsa-regressions', 'forge-suite', 'browser-bundles', 'expo-certificates', 'expo-update-signing', 'production-image'];
export function canonicalAudit(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalAudit).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAudit(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Traverse physical directories, including nested workspace installs and Bun's store.
// Resolve symlinks and deduplicate realpaths; unreadable paths throw (never silently omit).
export const ARM_PRUNING_RECEIPT = Object.freeze({ sourceSha: '81442f48fc8c5a7251dd4ae290e02c4afb1aa633', imageDigest: 'sha256:d11e581d88b3dcf92d5b09add482406f31db68f45be81af19a559967a70c4b67', receiptSha256: '4b3c6d088ea21592c6ee683cba3adc348c437591b515bf783e0f39d9ce4525dd' });
export const ARM_PRUNED_LINKS = [
  {
    "path": "node_modules/.bun/node_modules/@img/sharp-libvips-linux-arm64",
    "target": "../../@img+sharp-libvips-linux-arm64@1.3.3/node_modules/@img/sharp-libvips-linux-arm64"
  },
  {
    "path": "node_modules/.bun/node_modules/@img/sharp-linux-arm64",
    "target": "../../@img+sharp-linux-arm64@0.35.4/node_modules/@img/sharp-linux-arm64"
  },
  {
    "path": "node_modules/.bun/node_modules/ffmpeg-static",
    "target": "../ffmpeg-static@5.3.0+759ce506b1ed1a42/node_modules/ffmpeg-static"
  },
  {
    "path": "node_modules/.bun/node_modules/ffprobe-static",
    "target": "../ffprobe-static@3.1.0/node_modules/ffprobe-static"
  },
  {
    "path": "node_modules/.bun/sharp@0.35.4+5d01d69d87a479a5/node_modules/@img/sharp-libvips-linux-arm64",
    "target": "../../../@img+sharp-libvips-linux-arm64@1.3.3/node_modules/@img/sharp-libvips-linux-arm64"
  },
  {
    "path": "node_modules/.bun/sharp@0.35.4+5d01d69d87a479a5/node_modules/@img/sharp-linux-arm64",
    "target": "../../../@img+sharp-linux-arm64@0.35.4/node_modules/@img/sharp-linux-arm64"
  },
  {
    "path": "packages/api/node_modules/ffmpeg-static",
    "target": "../../../node_modules/.bun/ffmpeg-static@5.3.0+759ce506b1ed1a42/node_modules/ffmpeg-static"
  },
  {
    "path": "packages/api/node_modules/ffprobe-static",
    "target": "../../../node_modules/.bun/ffprobe-static@3.1.0/node_modules/ffprobe-static"
  }
];
export function inventory(root, { intentionalDanglingSharpLinks = [] } = {}) {
  root = realpathSync(resolve(root));
  const seen = new Set(); const copies = []; const omissions = []; const used = new Set();
  if (intentionalDanglingSharpLinks.length && canonicalAudit(intentionalDanglingSharpLinks) !== canonicalAudit(ARM_PRUNED_LINKS)) throw new Error('Exact eight reviewed ARM receipt pairs required');
  function approvedDanglingLink(path, error) {
    if (error.code !== 'ENOENT') return false;
    const rel = relative(root, path);
    const target = readlinkSync(path);
    const exact = intentionalDanglingSharpLinks.find(entry => entry.path === rel && entry.target === target);
    if (!exact) return false;
    // Exact receipt pairs pin parent directory, package version/peer suffix and
    // same-package destination. No regex or packages/* path exemption exists.
    const recorded = ARM_PRUNED_LINKS.find(entry => entry.path === rel && entry.target === target);
    if (!recorded) return false;
    // The physical store is traversed independently; this omission cannot suppress
    // any extant directory or a node-forge target. Only these eight explicitly Docker-pruned targets qualify.
    used.add(exact);
    omissions.push({ path: rel, target });
    return true;
  }
  function walk(path) {
    const real = realpathSync(path);
    if (seen.has(real)) return;
    seen.add(real);
    const entries = readdirSync(real, { withFileTypes: true });
    if (entries.some(e => e.name === 'package.json' && e.isFile())) {
      const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
      if (manifest.name === 'node-forge') {
        const files = Object.fromEntries(FILES.map(name => [name, sha256(readFileSync(join(real, name)))]));
        copies.push({ realpath: real, version: manifest.version, files });
      }
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const target = join(real, entry.name);
        // File symlinks need no descent, but broken/unreadable links fail.
        let resolved;
        try { resolved = realpathSync(target); } catch (error) {
          if (entry.isSymbolicLink() && approvedDanglingLink(target, error)) continue;
          throw error;
        }
        try { readdirSync(resolved); } catch (error) {
          if (error.code === 'ENOTDIR') continue;
          throw error;
        }
        walk(target);
      }
    }
  }
  walk(resolve(root));
  if (used.size !== intentionalDanglingSharpLinks.length) throw new Error('Unused or duplicate intentional Sharp omission entry');
  copies.sort((a,b) => a.realpath.localeCompare(b.realpath));
  omissions.sort((a,b) => a.path.localeCompare(b.path));
  Object.defineProperty(copies, 'intentionalDanglingSharpLinks', { value: omissions });
  return copies;
}
export const inventoryHash = copies => sha256(JSON.stringify({ copies, intentionalDanglingSharpLinks: copies?.intentionalDanglingSharpLinks ?? [] }));
export function evaluate({ audit, manifest, patchBytes, copies, evidenceBytes }) {
  const errors = [];
  const fail = text => errors.push(text);
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) fail('Missing raw audit object');
  const rawAuditSha256 = sha256(canonicalAudit(audit) ?? '');
  if (!hash(manifest?.rawAuditSha256) || manifest.rawAuditSha256 !== rawAuditSha256) fail('Whole raw audit differs from reviewed baseline');
  const advisories = audit?.['node-forge'];
  if (!Array.isArray(advisories) || advisories.length !== 1 || advisories[0]?.url !== `https://github.com/advisories/${ADVISORY}` || advisories[0]?.severity !== 'high') fail('Exact single raw Forge advisory required; new advisory fails');
  if (manifest?.advisory !== ADVISORY || manifest?.package !== 'node-forge' || manifest?.version !== '1.4.0') fail('Exact advisory/package/version required');
  if (!hash(manifest?.patchSha256) || sha256(patchBytes ?? '') !== manifest.patchSha256) fail('Missing or mismatched patch hash');
  if (!Array.isArray(copies) || copies.length === 0) fail('No installed copies proven');
  for (const copy of copies ?? []) {
    if (copy.version !== '1.4.0') fail(`Unexpected version at ${copy.realpath}`);
    for (const name of FILES) if (!hash(manifest?.files?.[name]) || copy.files?.[name] !== manifest.files[name]) fail(`Missing/unpatched distribution ${name} at ${copy.realpath}`);
  }
  if ((copies?.intentionalDanglingSharpLinks?.length ?? 0) > 0 && canonicalAudit(manifest?.pruningReceipt) !== canonicalAudit(ARM_PRUNING_RECEIPT)) fail('Missing or changed source-image pruning receipt');
  const inventorySha256 = inventoryHash(copies);
  if (!hash(manifest?.testEvidenceSha256) || sha256(evidenceBytes ?? '') !== manifest.testEvidenceSha256) fail('Missing or mismatched test evidence');
  let evidence;
  try { evidence = JSON.parse(evidenceBytes); } catch { fail('Invalid test evidence'); }
  if ((copies?.intentionalDanglingSharpLinks?.length ?? 0) > 0 && canonicalAudit(evidence?.pruningReceipt) !== canonicalAudit(ARM_PRUNING_RECEIPT)) fail('Test evidence does not bind source-image pruning receipt');
  if (evidence?.rawAuditSha256 !== rawAuditSha256 || evidence?.rawAuditSha256 !== manifest?.rawAuditSha256) fail('Tests do not bind the reviewed whole-audit baseline');
  if (evidence?.patchSha256 !== manifest?.patchSha256 || evidence?.inventorySha256 !== inventorySha256) fail('Tests do not bind this patch and installed inventory');
  for (const suite of SUITES) if (evidence?.suites?.[suite] !== 'pass') fail(`Missing/pending/failed suite: ${suite}`);
  if (!manifest?.independentSecurityReview?.reviewer || !hash(manifest?.independentSecurityReview?.reviewedPatchSha256) || manifest.independentSecurityReview.reviewedPatchSha256 !== manifest.patchSha256) fail('Independent security review absent or mismatched');
  return { proposalOnly: true, approved: false, technicalEvidenceComplete: errors.length === 0, errors, rawAudit: audit, rawAuditSha256, inventorySha256, intentionalDanglingSharpLinks: copies?.intentionalDanglingSharpLinks ?? [], remainingDecision: 'Separate parent policy authorization and verified review authenticity are mandatory. This script never approves or suppresses an advisory.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, auditPath, manifestPath, patchPath, evidencePath] = process.argv.slice(2);
  try {
    if (!evidencePath) throw new Error('Usage: node script ROOT RAW_AUDIT MANIFEST PATCH TEST_EVIDENCE');
    const result = evaluate({ audit: JSON.parse(readFileSync(auditPath)), manifest: JSON.parse(readFileSync(manifestPath)), patchBytes: readFileSync(patchPath), copies: inventory(root, { intentionalDanglingSharpLinks: JSON.parse(readFileSync(manifestPath)).intentionalDanglingSharpLinks ?? [] }), evidenceBytes: readFileSync(evidencePath) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1; // Always unapproved: deliberately cannot become an active green gate.
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
