/** INERT proposal. Never substitutes for the dependency audit or grants approval. */
import { readFileSync, readdirSync, realpathSync, readlinkSync, existsSync } from 'node:fs';
import { checkFrozenSourceTopology } from './forge-source-topology.mjs';
import { FORGE_MARKERS } from './forge-candidate-image-roots.mjs';
import { join, resolve, relative, dirname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { inflateRawSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
export const INDEPENDENT_INPUT_PATHS = Object.freeze(['packages', 'bun.lock', 'package.json', 'bunfig.toml', 'tsconfig.json', 'turbo.json', 'patches/node-forge@1.4.0.patch', 'docs/security/forge-candidate/toolchain.bun.lock', 'scripts/rehearsal/test-forge-final-input-1519.py', 'scripts/forge-independent-expo-compat.cjs']);
/** Structural tree traversal only. Synthetic GET callbacks confer no authentication. */
export function readPinnedIndependentInputObjects(sourceSha, getJson) {
  const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  if (!commitId(sourceSha)) throw new Error('Exact historical commit SHA required');
  const prefix = 'repos/OxyHQ/oxy/git/';
  const url = path => `https://api.github.com/${path}`;
  const path = `${prefix}commits/${sourceSha}`;
  const commit = getJson(path);
  if (commit?.sha !== sourceSha || commit.url !== url(path) || !commitId(commit.tree?.sha)
    || commit.tree.url !== url(`${prefix}trees/${commit.tree.sha}`)) throw new Error('Historical commit/repository/tree binding differs');
  const cache = new Map();
  const tree = sha => {
    if (!cache.has(sha)) {
      if (!commitId(sha) || cache.size >= 32) throw new Error('Historical tree traversal exceeds bound');
      const path = `${prefix}trees/${sha}`;
      const value = getJson(path);
      if (value?.sha !== sha || value.url !== url(path) || value.truncated !== false
        || !Array.isArray(value.tree) || value.tree.length > 2500
        || new Set(value.tree.map(entry => entry.path)).size !== value.tree.length) throw new Error('Historical tree is malformed, foreign, truncated or ambiguous');
      cache.set(sha, value.tree);
    }
    return cache.get(sha);
  };
  return Object.fromEntries(INDEPENDENT_INPUT_PATHS.map(input => {
    let at = commit.tree.sha;
    const parts = input.split('/');
    if (parts.length > 8) throw new Error('Historical input depth exceeds bound');
    for (const [index, name] of parts.entries()) {
      const entry = tree(at).find(value => value.path === name);
      const directory = index < parts.length - 1 || input === 'packages';
      if (!entry || !commitId(entry.sha) || (directory
        ? entry.type !== 'tree' || entry.mode !== '040000'
        : entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) throw new Error(`Historical input missing or wrong type: ${input}`);
      at = entry.sha;
    }
    return [input, at];
  }));
}
/** Fixed authenticated GETs; no repository, program, evidence or path override. */
export function collectIndependentInputObjects(sourceSha) {
  return readPinnedIndependentInputObjects(sourceSha, path => JSON.parse(execFileSync('/usr/bin/gh',
    ['api', '--hostname', 'github.com', '--method', 'GET', path],
    { env: toolEnv(), timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })));
}

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
    // Forge-shaped by location or content: a renamed/missing manifest never hides a copy.
    const forgeShaped = real.endsWith('/node-forge') || FORGE_MARKERS.some(marker => entries.length && existsSync(join(real, marker)));
    if (forgeShaped && !entries.some(e => e.name === 'package.json' && e.isFile())) throw new Error(`Forge-shaped directory without manifest: ${real}`);
    if (entries.some(e => e.name === 'package.json' && e.isFile())) {
      const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
      if (forgeShaped && (manifest.name !== 'node-forge' || typeof manifest.version !== 'string')) throw new Error(`Forge-shaped directory does not identify as node-forge: ${real}`);
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

// ── Trust roots ────────────────────────────────────────────────────────────
// TRUSTED_BASELINE is reviewed source. No caller file can move it: a caller who
// rewrites both a manifest and its test evidence still meets these constants.
const freeze = value => { if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const TRUSTED_BASELINE = freeze({
  advisory: ADVISORY, advisoryUrl: `https://github.com/advisories/${ADVISORY}`, severity: 'high',
  auditVulnerableVersions: '<=1.4.0', ghsaVulnerableRange: '<= 1.4.0', package: 'node-forge', version: '1.4.0',
  // Whole `bun audit --json` output, canonicalised: any new advisory anywhere changes it.
  rawAuditSha256: '8c6c938a06ddc218daed240793a26d4a0ed55f504b3edbc54cb415468bb0b6b8',
  patchSha256: '6c8b35a750038ddae3b2973dd81cad4826fa31744053c878cd8959338edcd776',
  files: {
    'lib/rsa.js': '425543a09d94457a66d098c490540b2759806dc61236ad3d38610c18d88f1b81',
    'dist/forge.min.js': '811a6061b91b04955ea1457a7d987f21a496f43304c4a89f870d2d175191a19f',
    'dist/forge.min.js.map': '5f11be794b0ad083ce9b2bcee1079e7ee1f0771d37beb90d6f13b2b9a8a0eba3',
    'dist/forge.all.min.js': 'fc2c8c484e3da7608ad5a966a8b747d7fe7c8ea7086b1f76ea8ead544dd7d232',
    'dist/forge.all.min.js.map': '0b21eb8fb1c124e963d564b6462177331027f6e739f48e73184e0f6a81cac3f1',
  },
  lockResolution: '"node-forge": ["node-forge@1.4.0", "", {}, "sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ=="]',
  lockPatch: '"node-forge@1.4.0": "patches/node-forge@1.4.0.patch"',
});
// Identity of the only workflow allowed to produce image evidence.
export const TRUSTED_WORKFLOW = freeze({
  repository: 'OxyHQ/oxy', repositoryId: 973881060, workflowId: 372697979, path: '.github/workflows/forge-candidate-image-proof.yml',
  name: 'Forge candidate image proof', job: 'candidate-image', runnerLabels: ['ubuntu-24.04-arm'], event: 'pull_request',
  os: 'linux', architecture: 'arm64', installedRoot: '/app', rootScanRoot: '/', rootScanExcluded: ['/dev', '/proc', '/proof/scripts', '/sys'],
  // Executed by the run; each blob at the run's merge ref must equal the blob at the evidence source.
  executedPaths: ['.github/workflows/forge-candidate-image-proof.yml', 'Dockerfile', 'scripts/forge-candidate-image-proof.mjs',
    'scripts/forge-remediation-proof-proposal.mjs', 'scripts/forge-source-topology.mjs', 'scripts/forge-candidate-regression.cjs', 'scripts/forge-candidate-dangling-links.mjs',
    'scripts/forge-candidate-image-roots.mjs', 'patches/node-forge@1.4.0.patch', 'docs/security/forge-candidate/candidate-hashes.json'],
  steps: ['Set up job', 'Run actions/checkout@v7', 'Verify the exact candidate source', 'Run docker/setup-buildx-action@v4',
    'Run crazy-max/ghaction-github-runtime@v4', 'Build the final production Dockerfile locally on ARM',
    'Verify proof mount targets are absent from the unmounted image',
    'Record actual final-image dangling links without exemptions', 'Discover every installed root in the whole image filesystem',
    'Verify all materialized copies and run own-key controls without network', 'Run actions/upload-artifact@v7',
    'Post Run docker/setup-buildx-action@v4', 'Post Run actions/checkout@v7', 'Complete job'],
  artifactFiles: ['forge-build-metadata.json', 'forge-image-dangling-links.json', 'forge-image-identity.txt', 'forge-image-regression-proof.json', 'forge-image-roots.json', 'forge-image-mount-targets.json'],
  // Bind-mount destinations used by later proof steps; each must be absent from the unmounted image.
  mountTargets: ['/proof/scripts', '/proof/hashes', '/proof/patches'],
});
// The only commit-to-commit difference tolerated between evidence source and the evaluating HEAD:
// recording the reviewed pins/fixtures for that source. Any code, workflow or image input change fails.
export const PROVENANCE_DIR = 'docs/security/forge-candidate/provenance/';
export const PINS_PATH = `${PROVENANCE_DIR}pins.json`;
const PIN_KEYS = ['sourceSha', 'pullRequest', 'headBranch', 'runId', 'runAttempt', 'jobId', 'workflowMergeSha', 'artifactId', 'artifactDigest', 'artifactFiles', 'image'];
// Machine-checked from the artifact; the rest are caller-run and stay with the parent.
export const MACHINE_SUITES = ['rsa-regressions', 'browser-bundles', 'production-image'];
export const LOCAL_ONLY_SUITES = ['forge-suite', 'expo-certificates', 'expo-update-signing'];
const CLAIM_KEYS = ['status', 'advisory', 'package', 'version', 'sourceHead', 'rawAuditSha256', 'patchSha256', 'files', 'testEvidenceSha256', 'intentionalDanglingSharpLinks', 'pruningReceipt'];
const EVIDENCE_KEYS = ['sourceHead', 'rawAuditSha256', 'patchSha256', 'inventorySha256', 'pruningReceipt', 'suites', 'counts', 'actualImage', 'limits'];
const same = (a, b) => canonicalAudit(a) === canonicalAudit(b);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Minimal stored/deflate ZIP reader: entries are taken only from the digest-checked bytes.
export function readZip(bytes) {
  bytes = Buffer.from(bytes);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Artifact is not a ZIP');
  const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16), size = bytes.readUInt32LE(offset + 20), length = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || entries.has(name)) throw new Error(`Unexpected or duplicate ZIP entry ${JSON.stringify(name)}`);
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt ZIP local header');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + size);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`Unsupported ZIP method ${method}`); })();
    if (data.length !== length || crc32(data) !== crc) throw new Error(`ZIP entry ${name} fails its CRC/size`);
    entries.set(name, data);
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

// The exact candidate matrix forge-candidate-regression.cjs must have produced (own-key controls only).
export function expectedRegressionRows() {
  const rows = [];
  const distributions = ['lib', 'forge.min.js', 'forge.all.min.js'];
  for (const algorithm of ['sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256', 'md5', 'md2']) {
    if (algorithm !== 'md2') for (const distribution of distributions) rows.push({ algorithm, variant: 'normal-sign', distribution, forgeAccepted: true, nodeAccepted: true });
    for (const variant of ['empty-null', 'absent-null', 'extra-nested', 'nonempty-null', 'extra-outer', 'trailing', 'wrong-digest', 'unknown-oid', 'wrong-oid-tag', 'wrong-algorithm-tag', 'empty-algorithm']) {
      const forgeAccepted = variant === 'empty-null' || (variant === 'absent-null' && !['md2', 'md5'].includes(algorithm));
      // OpenSSL's verdict on an absent NULL is algorithm-specific; the script records, not asserts, it.
      const nodeAccepted = algorithm === 'md2' ? null : variant === 'empty-null' ? true : variant === 'absent-null' ? 'boolean' : false;
      for (const distribution of distributions) rows.push({ algorithm, variant, distribution, forgeAccepted, nodeAccepted });
    }
  }
  return rows;
}

function checkAudit(audit, fail) {
  if (!isObject(audit)) { fail('Missing action-time raw audit object'); return ''; }
  const rawAuditSha256 = sha256(canonicalAudit(audit));
  if (rawAuditSha256 !== TRUSTED_BASELINE.rawAuditSha256) fail('Whole raw audit differs from the reviewed baseline (new, changed or removed advisory)');
  const advisories = audit['node-forge'];
  if (!Array.isArray(advisories) || advisories.length !== 1 || advisories[0]?.url !== TRUSTED_BASELINE.advisoryUrl
    || advisories[0]?.severity !== TRUSTED_BASELINE.severity || advisories[0]?.vulnerable_versions !== TRUSTED_BASELINE.auditVulnerableVersions) fail('Exact single raw Forge advisory required; new advisory fails');
  return rawAuditSha256;
}

function checkGit(git, pins, fail) {
  if (!isObject(git)) return fail('Missing git facts for the evaluating checkout');
  if (!/^[0-9a-f]{40}$/.test(git.head ?? '')) fail('Missing current HEAD');
  if (git.clean !== true) fail('Evaluating checkout is not clean');
  if (git.head !== pins.sourceSha) {
    // Never claim an earlier run proves changed source: only the reviewed pin record may differ.
    const topology = checkFrozenSourceTopology(git, pins);
    for (const error of topology.errors) fail(error);
    const foreign = (git.changedPaths ?? ['<unknown>']).filter(path => !path.startsWith(PROVENANCE_DIR));
    if (foreign.length) fail(`Evidence proves ${pins.sourceSha}, not current HEAD ${git.head}: changed outside the pin record: ${foreign.join(', ')}`);
  }
  if (sha256(git.patchBytes ?? '') !== TRUSTED_BASELINE.patchSha256) fail('Source patch differs from the reviewed patch');
  const lock = String(git.lockText ?? '');
  if ((lock.match(/\["node-forge@/g) ?? []).length !== 1 || !lock.includes(TRUSTED_BASELINE.lockResolution) || !lock.includes(TRUSTED_BASELINE.lockPatch)) fail('bun.lock must resolve exactly one patched node-forge@1.4.0');
  let hashes; try { hashes = JSON.parse(git.candidateHashes); } catch { hashes = null; }
  if (hashes?.status !== 'CANDIDATE_UNAPPROVED' || hashes?.patchSha256 !== TRUSTED_BASELINE.patchSha256
    || FILES.some(name => hashes?.files?.[name]?.candidateSha256 !== TRUSTED_BASELINE.files[name])
    || !same(hashes?.intentionalDanglingSharpLinks, ARM_PRUNED_LINKS) || !same(hashes?.pruningReceipt, ARM_PRUNING_RECEIPT)) fail('Committed candidate-hashes.json diverges from the reviewed baseline');
}

// Actions may erase run.pull_requests after merge. The live collector then
// obtains BOTH the exact pinned commit's PR association and the merged PR.
// An absent association or a caller-created object never authenticates facts.
function candidatePullRequestBound(github, pins) {
  const list = github?.run?.pull_requests;
  if (!Array.isArray(list)) return false;
  if (list.length) return list.some(pr => pr.number === pins.pullRequest);
  const pr = github.pullRequest;
  const repo = value => value?.full_name === TRUSTED_WORKFLOW.repository && value?.id === TRUSTED_WORKFLOW.repositoryId;
  const matching = github.sourcePullRequests?.filter(value => value.number === pins.pullRequest);
  const association = matching?.length === 1 ? matching[0] : null;
  return pr?.number === pins.pullRequest && pr.state === 'closed' && pr.merged === true
    && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? '') && /^[a-f0-9]{40}$/.test(pr.head?.sha ?? '')
    && pr.head?.ref === pins.headBranch && repo(pr.head?.repo) && pr.base?.ref === 'main' && repo(pr.base?.repo)
    && association?.head?.sha === pr.head.sha && association.head.ref === pr.head.ref && repo(association.head.repo)
    && association.base?.ref === pr.base.ref && repo(association.base.repo)
    && association.merge_commit_sha === pr.merge_commit_sha;
}

function checkGithub(github, git, pins, zip, now, fail) {
  if (!isObject(github)) return fail('Authenticated GitHub provenance unavailable');
  const { run, job, artifact, mergeCommit, blobsAtMerge, advisory } = github;
  const W = TRUSTED_WORKFLOW;
  if (run?.id !== pins.runId || run?.path !== W.path || run?.name !== W.name || run?.workflow_id !== W.workflowId || run?.event !== W.event
    || run?.head_sha !== pins.sourceSha || run?.head_branch !== pins.headBranch || run?.status !== 'completed' || run?.conclusion !== 'success'
    || run?.run_attempt !== pins.runAttempt || run?.repository?.full_name !== W.repository || run?.repository?.id !== W.repositoryId
    || run?.head_repository?.full_name !== W.repository || !candidatePullRequestBound(github, pins)) fail('Workflow run identity differs from the pinned run of the trusted workflow');
  if (job?.id !== pins.jobId || job?.run_id !== pins.runId || job?.run_attempt !== pins.runAttempt || job?.name !== W.job || job?.workflow_name !== W.name
    || job?.head_sha !== pins.sourceSha || job?.status !== 'completed' || job?.conclusion !== 'success' || !same(job?.labels, W.runnerLabels)) fail('Job identity/architecture differs from the trusted ARM job');
  if (!same(job?.steps?.map(step => step.name), W.steps) || job?.steps?.some(step => step.conclusion !== 'success')) fail('Job steps differ from the trusted workflow (mount-target check or whole-image root discovery missing, or a step did not succeed)');
  const zipDigest = `sha256:${sha256(zip ?? '')}`;
  if (artifact?.id !== pins.artifactId || artifact?.name !== `forge-candidate-image-proof-${pins.runId}` || artifact?.digest !== pins.artifactDigest || zipDigest !== pins.artifactDigest
    || artifact?.size_in_bytes !== zip?.length || artifact?.expired !== false || artifact?.workflow_run?.id !== pins.runId
    || artifact?.workflow_run?.head_sha !== pins.sourceSha || artifact?.workflow_run?.repository_id !== W.repositoryId) fail('Artifact identity/digest differs from the authenticated run artifact');
  const time = value => Date.parse(value ?? '');
  if (!(time(git?.sourceCommitTime) <= time(run?.created_at)) || !(time(job?.started_at) <= time(artifact?.created_at) && time(artifact?.created_at) <= time(job?.completed_at))
    || !(time(now) < time(artifact?.expires_at))) fail('Stale or replayed evidence: run/artifact timing does not bind to this source');
  if (mergeCommit?.sha !== pins.workflowMergeSha || mergeCommit?.parents?.length !== 2 || mergeCommit.parents[1] !== pins.sourceSha) fail('Executed workflow ref is not the merge of the evidence source');
  for (const path of W.executedPaths) if (!blobsAtMerge?.[path] || blobsAtMerge[path] !== git?.blobsAtSource?.[path]) fail(`Executed ${path} differs from (or is absent in) the evidence source`);
  const vulnerabilities = advisory?.vulnerabilities ?? [];
  if (advisory?.ghsa_id !== ADVISORY || advisory?.severity !== 'high' || advisory?.withdrawn_at !== null || vulnerabilities.length !== 1
    || vulnerabilities[0]?.package?.ecosystem !== 'npm' || vulnerabilities[0]?.package?.name !== 'node-forge'
    || vulnerabilities[0]?.vulnerable_version_range !== TRUSTED_BASELINE.ghsaVulnerableRange || vulnerabilities[0]?.first_patched_version !== null) fail('Live GHSA record changed (scope, severity, withdrawal or an upstream fix now exists)');
}

function checkArtifact(entries, pins, fail, profile = 'pull_request') {
  const W = TRUSTED_WORKFLOW;
  const derived = {};
  if (!entries) { fail('Artifact bytes unavailable'); return derived; }
  for (const name of W.artifactFiles) {
    if (!entries.has(name)) fail(`Artifact lacks ${name}${name === 'forge-image-roots.json' ? ': complete installed-root set cannot be derived' : ''}`);
    else if (sha256(entries.get(name)) !== pins.artifactFiles?.[name]) fail(`Artifact ${name} differs from the pinned bytes`);
  }
  for (const name of entries.keys()) if (!W.artifactFiles.includes(name)) fail(`Unexpected artifact entry ${name}`);
  const json = name => { try { return JSON.parse(entries.get(name)); } catch { return null; } };
  const identity = String(entries.get('forge-image-identity.txt') ?? '').trim().split(' ').map(token => { try { return JSON.parse(token); } catch { return null; } });
  const [configId, architecture, os, revision] = identity;
  if (identity.length !== 4 || !/^sha256:[0-9a-f]{64}$/.test(configId ?? '') || architecture !== W.architecture || os !== W.os || revision !== pins.sourceSha) fail('Image identity is not the ARM image of the evidence source');
  const metadata = json('forge-build-metadata.json');
  const environment = metadata?.['buildx.build.provenance']?.invocation?.environment;
  const request = metadata?.['buildx.build.provenance']?.invocation?.parameters?.root?.request?.args;
  const manifestDigest = profile === 'queue' ? pins.image.manifestDigest : metadata?.['containerimage.digest'];
  if (profile === 'pull_request' && (metadata?.['containerimage.config.digest'] !== configId || !/^sha256:[0-9a-f]{64}$/.test(manifestDigest ?? '') || manifestDigest === configId
    || metadata?.['containerimage.descriptor']?.digest !== manifestDigest || !same(metadata?.['containerimage.descriptor']?.platform, { architecture: W.architecture, os: W.os })
    || metadata?.['image.name'] !== `docker.io/library/oxy-forge-candidate:${pins.sourceSha}`
    || request?.['vcs:revision'] !== pins.sourceSha || request?.['vcs:source'] !== `https://github.com/${W.repository}` || request?.['label:org.opencontainers.image.revision'] !== pins.sourceSha
    || environment?.github_run_id !== String(pins.runId) || environment?.github_run_attempt !== String(pins.runAttempt) || environment?.github_job !== W.job
    || environment?.github_repository !== W.repository || environment?.github_repository_id !== String(W.repositoryId) || environment?.github_workflow_sha !== pins.workflowMergeSha
    || environment?.github_runner_arch !== 'ARM64' || environment?.github_runner_environment !== 'github-hosted' || environment?.platform !== `${W.os}/${W.architecture}`
    || environment?.github_event_payload?.pull_request?.head?.sha !== pins.sourceSha || environment?.github_event_payload?.number !== pins.pullRequest)) fail('Build provenance does not bind this source, run, workflow and ARM platform');
  if (profile === 'queue' && (metadata?.['containerimage.config.digest'] !== configId || metadata?.['containerimage.digest'] !== pins.image.manifestDigest)) fail('Queue build metadata differs from inspected config/OCI digest');
  if (!same(pins.image, { configId, manifestDigest })) fail('Pinned image identity differs from the artifact image');
  derived.image = { configId, manifestDigest, platform: `${W.os}/${W.architecture}` };
  // Mount targets: proven absent, before any mount, in this exact source's image.
  const mountTargets = json('forge-image-mount-targets.json');
  if (!same(mountTargets, { diagnosticOnly: true, approval: false, mounts: 'none', sourceSha: pins.sourceSha, imageId: configId,
    targets: W.mountTargets.map(path => ({ path, present: false })) })) fail('Unmounted image does not prove every proof mount target absent for this source and image');
  // Pruning receipt: the current image's raw (unexempted) diagnostic must reproduce the reviewed receipt bytes exactly.
  const dangling = json('forge-image-dangling-links.json');
  if (sha256(entries.get('forge-image-dangling-links.json') ?? '') !== ARM_PRUNING_RECEIPT.receiptSha256 || dangling?.root !== W.installedRoot || dangling?.approval !== false
    || !same(dangling?.danglingLinks?.map(({ path, target }) => ({ path, target })), ARM_PRUNED_LINKS)
    || dangling.danglingLinks.some(link => link.errorCode !== 'ENOENT' || link.absoluteResolution !== posix.resolve(W.installedRoot, posix.dirname(link.path), link.target))) fail('Image dangling links are not exactly the eight reviewed Docker-pruned links');
  const proof = json('forge-image-regression-proof.json');
  const copies = Array.isArray(proof?.copies) ? proof.copies : [];
  Object.defineProperty(copies, 'intentionalDanglingSharpLinks', { value: proof?.intentionalDanglingSharpLinks ?? [] });
  if (proof?.candidateOnly !== true || proof?.approved !== false || proof?.technicalByteRegressionProofPassed !== true || proof?.platform !== W.os || proof?.arch !== W.architecture
    || proof?.installedRoot !== W.installedRoot || proof?.patchSha256 !== TRUSTED_BASELINE.patchSha256 || !same(proof?.earlierPruningReceipt, ARM_PRUNING_RECEIPT)
    || !same(proof?.intentionalDanglingSharpLinks, ARM_PRUNED_LINKS) || proof?.inventorySha256 !== inventoryHash(copies)) fail('Image proof does not bind the trusted root, patch, receipt and inventory');
  if (copies.length === 0) fail('No installed copies proven');
  if (new Set(copies.map(copy => copy.realpath)).size !== copies.length) fail('Duplicate physical copy in inventory');
  for (const copy of copies) {
    if (!String(copy.realpath).startsWith(`${W.installedRoot}/`)) fail(`Copy outside the trusted installed root: ${copy.realpath}`);
    if (copy.version !== TRUSTED_BASELINE.version) fail(`Unexpected version at ${copy.realpath}`);
    if (!same(Object.keys(copy.files ?? {}).sort(), [...FILES].sort()) || FILES.some(name => copy.files[name] !== TRUSTED_BASELINE.files[name])) fail(`Missing/unpatched distribution at ${copy.realpath}`);
    const report = proof.regressions?.filter(entry => entry.realpath === copy.realpath) ?? [];
    const expected = expectedRegressionRows();
    const rows = report[0]?.rows ?? [];
    const rowsMatch = rows.length === expected.length && rows.every((row, i) => Object.keys(row).length === 5 && ['algorithm', 'variant', 'distribution', 'forgeAccepted'].every(key => row[key] === expected[i][key])
      && (expected[i].nodeAccepted === 'boolean' ? typeof row.nodeAccepted === 'boolean' : row.nodeAccepted === expected[i].nodeAccepted));
    const reportSha256 = report[0] && sha256(JSON.stringify({ mode: 'candidate', node: report[0].node, openssl: report[0].openssl, packageVersion: '1.4.0',
      packageFiles: { 'lib/rsa.js': copy.files['lib/rsa.js'], 'dist/forge.min.js': copy.files['dist/forge.min.js'], 'dist/forge.all.min.js': copy.files['dist/forge.all.min.js'] },
      publicKeySha256: report[0].publicKeySha256, knownKeyControlsOnly: true, count: report[0].count, rows }));
    if (report.length !== 1 || report[0].count !== 321 || report[0].node !== proof.node || !rowsMatch || reportSha256 !== report[0].reportSha256) fail(`Own-key regression matrix (lib + both bundles) not proven at ${copy.realpath}`);
  }
  if ((proof?.regressions?.length ?? -1) !== copies.length) fail('Regression reports do not correspond one-to-one with copies');
  // Complete root set: derived from a whole-filesystem scan inside the same image, never a caller list.
  const roots = json('forge-image-roots.json');
  if (roots) {
    const physical = (roots.forgeCopies ?? []).map(({ path, version, files }) => ({ realpath: path, version, files }));
    const sorted = list => [...list].sort((a, b) => a.realpath.localeCompare(b.realpath));
    if (roots.root !== W.rootScanRoot || roots.approval !== false || !same(roots.excluded, W.rootScanExcluded) || !Array.isArray(roots.installRoots)
      || !roots.installRoots.includes(W.installedRoot)) fail('Whole-image root scan is not the trusted complete scan');
    if (!same(sorted(physical), sorted([...copies]))) fail('Physical Forge copies in the whole image differ from the /app inventory (copy outside claimed roots)');
    derived.installedRoots = roots.installRoots;
  }
  derived.copies = copies;
  derived.inventorySha256 = inventoryHash(copies);
  return derived;
}

/** Queue artifact content only: authentication/OCI transport are a separate collector. */
export function checkQueueForgeImageContent(entries, sourceSha, image) {
  const errors = [];
  const originalEntries = new Map(TRUSTED_WORKFLOW.artifactFiles.filter(name => entries.has(name)).map(name => [name, entries.get(name)]));
  const pins = { sourceSha, image, artifactFiles: Object.fromEntries([...originalEntries].map(([name, bytes]) => [name, sha256(bytes)])) };
  const derived = checkArtifact(originalEntries, pins, message => errors.push(message), 'queue');
  return { structurallyEligible: errors.length === 0, authorized: false, errors, derived };
}

function checkCallerAssertions({ claim, testEvidenceBytes }, derived, pins, fail, unverified) {
  if (claim !== undefined) {
    if (!isObject(claim)) return fail('Caller manifest is not an object');
    for (const key of Object.keys(claim)) if (!CLAIM_KEYS.includes(key)) fail(`Caller manifest field ${key} is not accepted: review/approval metadata is never caller authority`);
    if (claim.status !== 'CANDIDATE_UNAPPROVED') fail('Caller manifest must stay CANDIDATE_UNAPPROVED');
    if (claim.advisory !== ADVISORY || claim.package !== 'node-forge' || claim.version !== '1.4.0') fail('Exact advisory/package/version required');
    if (claim.rawAuditSha256 !== TRUSTED_BASELINE.rawAuditSha256 || claim.patchSha256 !== TRUSTED_BASELINE.patchSha256 || !same(claim.files, TRUSTED_BASELINE.files)) fail('Caller manifest baseline differs from the trusted baseline');
    if (claim.sourceHead !== pins?.sourceSha) fail('Caller manifest source differs from the authenticated evidence source');
    if ('intentionalDanglingSharpLinks' in claim && !same(claim.intentionalDanglingSharpLinks, ARM_PRUNED_LINKS)) fail('Caller omissions differ from the exact eight reviewed links');
    if ('pruningReceipt' in claim && !same(claim.pruningReceipt, ARM_PRUNING_RECEIPT)) fail('Missing or changed source-image pruning receipt');
    if (testEvidenceBytes !== undefined && claim.testEvidenceSha256 !== sha256(testEvidenceBytes)) fail('Missing or mismatched test evidence hash');
  }
  if (testEvidenceBytes === undefined) return;
  let evidence; try { evidence = JSON.parse(testEvidenceBytes); } catch { return fail('Invalid test evidence'); }
  if (!isObject(evidence)) return fail('Invalid test evidence');
  for (const key of Object.keys(evidence)) if (!EVIDENCE_KEYS.includes(key)) fail(`Test evidence field ${key} is not accepted`);
  if (evidence.sourceHead !== pins?.sourceSha) fail('Test evidence source differs from the authenticated evidence source');
  if (evidence.rawAuditSha256 !== TRUSTED_BASELINE.rawAuditSha256) fail('Tests do not bind the reviewed whole-audit baseline');
  if (evidence.patchSha256 !== TRUSTED_BASELINE.patchSha256 || evidence.inventorySha256 !== derived.inventorySha256) fail('Tests do not bind this patch and installed inventory');
  if (!same(evidence.pruningReceipt, ARM_PRUNING_RECEIPT)) fail('Test evidence does not bind source-image pruning receipt');
  const image = evidence.actualImage;
  if (image?.configId !== derived.image?.configId || image?.manifestDigest !== derived.image?.manifestDigest || image?.platform !== derived.image?.platform || image?.run !== pins?.runId) fail('Test evidence image/run differs from the authenticated artifact');
  if (evidence.limits?.policyApproved !== false) fail('Test evidence must state policyApproved:false');
  if (evidence.counts?.rsaControls !== undefined && evidence.counts.rsaControls !== 321) fail('Test evidence RSA control count differs from the artifact');
  for (const suite of SUITES) if (evidence.suites?.[suite] !== 'pass') fail(`Missing/pending/failed suite: ${suite}`);
  for (const suite of LOCAL_ONLY_SUITES) unverified.push(`Caller-run suite ${suite} (claimed ${JSON.stringify(evidence.suites?.[suite])}) is not machine-verifiable`);
}

/**
 * `facts` are action-time audit, git objects, GitHub reads and artifact bytes. Only collect()'s own
 * return value is authenticated; anything else is a structural fixture check. The OPTIONAL caller
 * claim/evidence can only add errors, never authority.
 */
export function evaluate(facts = {}, { claim, testEvidenceBytes } = {}) {
  const { audit, pins, git, github, artifactZip } = facts;
  // Authenticated only when these exact facts came from collect() in this process.
  const authenticatedProvenance = COLLECTED.has(facts);
  const errors = [];
  const fail = text => { if (!errors.includes(text)) errors.push(text); };
  const rawAuditSha256 = checkAudit(audit, fail);
  const validPins = isObject(pins) && same(Object.keys(pins).sort(), [...PIN_KEYS].sort()) && /^[0-9a-f]{40}$/.test(pins.sourceSha) && isObject(pins.artifactFiles) && isObject(pins.image);
  if (!validPins) fail('Missing reviewed provenance pins');
  const safePins = validPins ? pins : {};
  let entries = null;
  if (artifactZip) { try { entries = readZip(artifactZip); } catch (error) { fail(`Artifact unreadable: ${error.message}`); } }
  if (validPins) {
    checkGit(git, safePins, fail);
    checkGithub(github, git, safePins, artifactZip,
      authenticatedProvenance ? new Date().toISOString() : facts.now, fail);
  }
  const derived = validPins ? checkArtifact(entries, safePins, fail) : {};
  const unverified = [];
  checkCallerAssertions({ claim, testEvidenceBytes }, derived, validPins ? safePins : undefined, fail, unverified);
  if (testEvidenceBytes === undefined) for (const suite of LOCAL_ONLY_SUITES) unverified.push(`Caller-run suite ${suite} has no machine-verifiable evidence`);
  unverified.push('Authenticity of the independent security review (never accepted from a caller field)', 'Audit-policy authorization for this advisory');
  if (!authenticatedProvenance) unverified.unshift('Provenance facts were supplied by the caller, not gathered by the live collector: structural check only');
  // Live facts can be held across other collectors/waits. Recheck provenance
  // expiry at this verdict; synthetic fixture time is never runtime authority.
  if (validPins && authenticatedProvenance) checkGithub(github, git, safePins, artifactZip,
    new Date().toISOString(), fail);
  return { proposalOnly: true, approved: false, authenticatedProvenance, structuralChecksPassed: errors.length === 0,
    machineChecksPassed: authenticatedProvenance && errors.length === 0, technicalEvidenceComplete: authenticatedProvenance && errors.length === 0 && unverified.length === 0,
    evaluationBasis: authenticatedProvenance ? 'action-time: git objects, bun audit, authenticated read-only GitHub GET, digest-checked artifact bytes' : 'STRUCTURAL ONLY: caller-supplied facts; grants no authenticated status',
    errors, requiresParentDecision: unverified, machineVerifiedSuites: authenticatedProvenance && errors.length === 0 ? MACHINE_SUITES : [],
    evidenceSource: safePins.sourceSha ?? null, currentHead: git?.head ?? null, evidenceIsForCurrentHead: !!git?.head && git.head === safePins.sourceSha,
    collectorRuntime: authenticatedProvenance ? facts.runtime : null, run: safePins.runId ?? null, image: derived.image ?? null, installedRoots: derived.installedRoots ?? null,
    rawAudit: audit, rawAuditSha256, inventorySha256: derived.inventorySha256 ?? null, intentionalDanglingSharpLinks: derived.copies?.intentionalDanglingSharpLinks ?? [],
    remainingDecision: 'Separate parent policy authorization and verified review authenticity are mandatory. This script never approves or suppresses an advisory.' };
}

// ── Action-time collection (read-only) ─────────────────────────────────────
// Every fact comes from git objects, `bun audit`, or authenticated GET requests through the
// existing `gh` login. Nothing is written remotely; any unavailable read fails closed.
function attempt(task, tries = 3) {
  for (let n = 1; ; n++) {
    try { return task(); } catch (error) {
      if (n >= tries) throw error;
      execFileSync('sleep', [String(2 * n)]);
    }
  }
}
// Facts objects created by collect() itself. Module-private: no caller can add to it, so JSON or
// mocked facts (however coherent) are evaluated structurally but never reported as authenticated.
const COLLECTED = new WeakSet();
// Fixed binaries, an OS-derived home and a scrubbed environment: no caller-selected program, no
// GH_HOST/enterprise redirection, no token, registry or config override reaches git, gh or bun.
const HOME = userInfo().homedir;
const BINARIES = { git: '/usr/bin/git', gh: '/usr/bin/gh' };
const BUN_LOCATIONS = ['/usr/local/bin/bun', '/usr/bin/bun', `${HOME}/.bun/bin/bun`];
export const TRUSTED_BUN_VERSION = '1.4.2';
function toolEnv() {
  const env = { ...process.env, HOME };
  for (const key of Object.keys(env)) if (/^(GH_|GITHUB_|GIT_|BUN_|NPM_CONFIG_|XDG_CONFIG_HOME$)/i.test(key)) delete env[key];
  return env;
}
export function collect(options = {}) {
  const overrides = Object.keys(options).filter(key => key !== 'repoRoot');
  if (overrides.length) throw new Error(`collect accepts no runtime overrides: ${overrides.join(', ')}`);
  const repoRoot = options.repoRoot ?? process.cwd();
  const env = toolEnv();
  const exec = (file, args, extra = {}) => execFileSync(BINARIES[file], args, { env, ...extra });
  BINARIES.bun = BUN_LOCATIONS.find(path => existsSync(path));
  if (!BINARIES.bun) throw new Error(`No Bun at a fixed location (${BUN_LOCATIONS.join(', ')})`);
  const git = (...args) => exec('git', ['-C', repoRoot, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = (...args) => git(...args).toString('utf8').trim();
  const head = text('rev-parse', 'HEAD');
  const pins = JSON.parse(git('show', `HEAD:${PINS_PATH}`));
  const source = pins.sourceSha;
  if (!/^[0-9a-f]{40}$/.test(source ?? '')) throw new Error('Pinned source is not a commit id');
  let sourceIsAncestor = true;
  try { git('merge-base', '--is-ancestor', source, head); } catch { sourceIsAncestor = false; }
  const blob = (ref, path) => { try { return text('rev-parse', `${ref}:${path}`); } catch { return null; } };
  const facts = {
    head, clean: text('status', '--porcelain', '--untracked-files=all') === '', sourceIsAncestor,
    changedPaths: text('diff', '--name-only', source, head).split('\n').filter(Boolean),
    headParents: text('show', '-s', '--format=%P', head).split(' ').filter(Boolean), headTree: text('rev-parse', 'HEAD^{tree}'),
    blobsAtSource: Object.fromEntries(TRUSTED_WORKFLOW.executedPaths.map(path => [path, blob(source, path)])),
    sourceCommitTime: text('show', '-s', '--format=%cI', source),
    patchBytes: git('show', `${source}:patches/node-forge@1.4.0.patch`),
    lockText: git('show', `${source}:bun.lock`).toString('utf8'),
    candidateHashes: git('show', `${source}:docs/security/forge-candidate/candidate-hashes.json`).toString('utf8'),
  };
  // `bun audit` exits non-zero while any advisory exists; its stdout is the whole report.
  const bunVersion = exec('bun', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  if (bunVersion !== TRUSTED_BUN_VERSION || JSON.parse(git('show', 'HEAD:package.json')).packageManager !== `bun@${TRUSTED_BUN_VERSION}`) throw new Error(`Bun ${bunVersion} at ${BINARIES.bun} is not the repository's bun@${TRUSTED_BUN_VERSION}`);
  const runtime = { git: BINARIES.git, gh: BINARIES.gh, bun: BINARIES.bun, bunVersion, bunSha256: sha256(readFileSync(BINARIES.bun)) };
  const audit = attempt(() => {
    try { return JSON.parse(exec('bun', ['audit', '--json'], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (error) { if (error.stdout?.length) return JSON.parse(error.stdout); throw error; }
  });
  const R = `repos/${TRUSTED_WORKFLOW.repository}`;
  const api = (path, raw = false) => attempt(() => {
    const bytes = exec('gh', ['api', '--hostname', 'github.com', '--method', 'GET', path], { maxBuffer: 64 * 1024 * 1024, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return raw ? bytes : JSON.parse(bytes);
  });
  // Non-descendant commits require actual GitHub merge-group provenance. A ref or
  // caller object alone is not authentication; these GETs run through this collector.
  if (!sourceIsAncestor || process.env.GITHUB_RUN_ID !== undefined) {
    const currentRunId = process.env.GITHUB_RUN_ID;
    if (!/^[1-9][0-9]*$/.test(currentRunId ?? '')) throw new Error('Non-descendant checkout requires a current authenticated Actions run');
    const currentCommit = api(`${R}/git/commits/${head}`);
    facts.currentGithub = { run: api(`${R}/actions/runs/${currentRunId}`), commit: {
      sha: currentCommit.sha, tree: currentCommit.tree?.sha, parents: currentCommit.parents.map(parent => parent.sha),
    } };
    if (['push', 'workflow_dispatch'].includes(facts.currentGithub.run.event)) {
      // Deploy reuses exactly the queue SHA. Authenticate that queue run as a
      // separate source attestation, rather than pretending a push is merge_group.
      const queueRuns = api(`${R}/actions/workflows/ci.yml/runs?head_sha=${head}&event=merge_group&per_page=100`).workflow_runs;
      const queue = queueRuns.filter(run => run.head_sha === head && run.event === 'merge_group'
        && run.repository?.id === TRUSTED_WORKFLOW.repositoryId && run.head_repository?.full_name === TRUSTED_WORKFLOW.repository)
        .sort((a, b) => b.id - a.id)[0];
      if (!queue || queue.status !== 'completed' || queue.conclusion !== 'success') throw new Error('Actual main execution requires its successful exact-SHA merge-group CI');
      facts.currentGithub.queueRun = queue;
    }

  }
  const contents = path => { try { return api(`${R}/contents/${path}?ref=${pins.workflowMergeSha}`).sha; } catch { return null; } };
  const mergeCommit = api(`${R}/git/commits/${pins.workflowMergeSha}`);
  const github = {
    run: api(`${R}/actions/runs/${pins.runId}`), job: api(`${R}/actions/jobs/${pins.jobId}`), artifact: api(`${R}/actions/artifacts/${pins.artifactId}`),
    mergeCommit: { sha: mergeCommit.sha, parents: mergeCommit.parents.map(parent => parent.sha) },
    blobsAtMerge: Object.fromEntries(TRUSTED_WORKFLOW.executedPaths.map(path => [path, contents(path)])),
    advisory: api(`/advisories/${ADVISORY}`),
  };
  if (Array.isArray(github.run.pull_requests) && github.run.pull_requests.length === 0) {
    github.pullRequest = api(`${R}/pulls/${pins.pullRequest}`);
    github.sourcePullRequests = api(`${R}/commits/${source}/pulls?per_page=100`);
    if (!Array.isArray(github.sourcePullRequests) || github.sourcePullRequests.length >= 100) throw new Error('Pinned source PR associations unavailable or exceed bounded page');
  }
  const artifactZip = api(`${R}/actions/artifacts/${pins.artifactId}/zip`, true);
  const collected = freeze({ audit, pins, git: facts, github, artifactZip, runtime, now: new Date().toISOString() });
  COLLECTED.add(collected);
  return collected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [claimPath, evidencePath] = process.argv.slice(2);
  let result;
  try {
    const facts = collect({ repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..') });
    result = evaluate(facts, { claim: claimPath ? JSON.parse(readFileSync(claimPath)) : undefined, testEvidenceBytes: evidencePath ? readFileSync(evidencePath) : undefined });
  } catch (error) {
    result = { proposalOnly: true, approved: false, authenticatedProvenance: false, machineChecksPassed: false, technicalEvidenceComplete: false, errors: [`Provenance unavailable, failing closed: ${error.message.split('\n')[0]}`] };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1; // Always unapproved: deliberately cannot become an active green gate.
}
