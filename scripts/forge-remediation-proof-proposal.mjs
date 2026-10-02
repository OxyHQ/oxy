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
export function inventory(root, { intentionalDanglingSharpLinks = [] } = {}) {
  root = realpathSync(resolve(root));
  const seen = new Set(); const copies = []; const omissions = []; const used = new Set();
  const sharpName = /^(sharp-linux|sharp-libvips-linux)-(arm|arm64|ia32|x64|ppc64|s390x|riscv64)$/;
  function approvedDanglingLink(path, error) {
    if (error.code !== 'ENOENT') return false;
    const rel = relative(root, path);
    const prefix = 'node_modules/.bun/node_modules/@img/';
    if (!rel.startsWith(prefix) || rel.slice(prefix.length).includes('/')) return false;
    const name = rel.slice(prefix.length);
    if (!sharpName.test(name)) return false;
    const target = readlinkSync(path); // ordinary missing files and unreadable links fail
    const exact = intentionalDanglingSharpLinks.find(entry => entry.path === rel && entry.target === target);
    if (!exact) return false;
    const destination = resolve(path, '..', target);
    const store = join(root, 'node_modules/.bun');
    const expected = new RegExp(`^@img\\+${name}@[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?/node_modules/@img/${name}$`);
    if (!expected.test(relative(store, destination))) return false;
    // The physical store is traversed independently; this omission cannot suppress
    // any extant directory or a node-forge target. Only the deleted Sharp target qualifies.
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
  const inventorySha256 = inventoryHash(copies);
  if (!hash(manifest?.testEvidenceSha256) || sha256(evidenceBytes ?? '') !== manifest.testEvidenceSha256) fail('Missing or mismatched test evidence');
  let evidence;
  try { evidence = JSON.parse(evidenceBytes); } catch { fail('Invalid test evidence'); }
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
