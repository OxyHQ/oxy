/** Read-only companion for the unapplied image DAG. Never activates policy or publishes. */
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScopedPolicyRecord } from './forge-policy-record.mjs';
import { checkFinalImageBinding, FINAL_IMAGE_EXECUTED_PATHS } from './forge-final-image-binding.mjs';
import { readZip, sha256, PINS_PATH, TRUSTED_WORKFLOW, checkQueueForgeImageContent, ensurePinnedGitSource } from './forge-remediation-proof-proposal.mjs';
const REPOSITORY = 'OxyHQ/oxy', REPOSITORY_ID = 973881060;
const DECISION_PATH = 'docs/security/forge-candidate/provenance/audit-policy-decision.json';
export const FINAL_PROOF_FILES = Object.freeze([...TRUSTED_WORKFLOW.artifactFiles,
  'forge-oci-receipt.json', 'forge-oci-manifest.json', 'forge-oci-config.json', 'forge-scan-image-ids.json', 'forge-queue-execution.json']);
const uploadIndex = TRUSTED_WORKFLOW.steps.indexOf('Run actions/upload-artifact@v7');
export const FINAL_INSPECTION_STEPS = Object.freeze([...TRUSTED_WORKFLOW.steps.slice(0, uploadIndex + 1), 'Run actions/upload-artifact@v7', ...TRUSTED_WORKFLOW.steps.slice(uploadIndex + 1)]);
const COLLECTED = new WeakSet();
const freeze = x => { if (x && typeof x === 'object' && !ArrayBuffer.isView(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const hex = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
function environment() {
  const env = { ...process.env, HOME: userInfo().homedir };
  for (const key of Object.keys(env)) if (/^(GH_|GITHUB_|GIT_|BUN_|NPM_CONFIG_|XDG_CONFIG_HOME$|AWS_ENDPOINT_URL)/i.test(key)) delete env[key];
  return env;
}
/** Pure state predicate: no waiting, no network, no approval. */
export function selectFinalInspection(runs, jobs, artifacts, head) {
  const eligible = runs.filter(run => run.event === 'merge_group' && run.head_sha === head
    && run.repository?.full_name === REPOSITORY && run.repository?.id === REPOSITORY_ID
    && run.head_repository?.full_name === REPOSITORY && run.path === '.github/workflows/forge-queue-image-inspection.yml')
    .sort((a, b) => b.id - a.id);
  const run = eligible[0];
  if (!run) return { state: 'pending', reason: 'No exact-SHA inspection run' };
  const matchingJobs = jobs.filter(job => job.run_id === run.id && job.name === 'inspection' && job.run_attempt === run.run_attempt);
  if (matchingJobs.length > 1) return { state: 'failed', reason: 'Ambiguous inspection jobs' };
  const job = matchingJobs[0];
  if (!job || job.status !== 'completed') {
    if (run.status === 'completed') return { state: 'failed', reason: 'Inspection workflow ended without a completed inspection job' };
    return { state: 'pending', reason: 'Inspection job not complete' };
  }
  if (job.conclusion !== 'success') return { state: 'failed', reason: 'Inspection job did not succeed' };
  // The workflow may still be running its CI wait/publisher. Never wait for it.
  const proofs = artifacts.filter(x => x.name === `forge-queue-proof-${head}-${run.id}-${run.run_attempt}` && x.workflow_run?.id === run.id);
  const archives = artifacts.filter(x => x.name === `forge-queue-oci-${head}-${run.id}-${run.run_attempt}` && x.workflow_run?.id === run.id);
  if (proofs.length > 1 || archives.length > 1) return { state: 'failed', reason: 'Ambiguous proof/OCI artifacts' };
  const proof = proofs[0], archive = archives[0];
  if (!proof || !archive) return { state: 'pending', reason: 'Inspection transport artifacts not yet visible' };
  return { state: 'ready', run, job, artifact: proof, archiveArtifact: archive };
}
/** Bounded pagination, reusable by offline fixtures. It conveys no authentication. */
export function listFinalPages(getPage, path, key) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const reply = getPage(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(reply?.[key]) || reply[key].length > 100) throw new Error('Malformed provenance page');
    rows.push(...reply[key]);
    if (reply[key].length < 100) return rows;
  }
  throw new Error('Provenance pagination exceeds 2000-record limit');
}
export function assertFinalWaitDeadline(now, deadline) {
  if (!(now < deadline)) throw new Error('Bounded final-image inspection wait expired');
}
/** Structural clock fixture only; the live path always supplies a fresh OS time. */
export function checkFinalProofFreshness(decision, source, artifacts, now) {
  const record = checkScopedPolicyRecord(decision, now, source);
  const errors = [...record.errors];
  if (record.status !== 'ACTIVE') errors.push('Explicit ACTIVE policy required');
  if (!Number.isFinite(Date.parse(now)) || artifacts.length !== 2
    || artifacts.some(artifact => artifact?.expired !== false || !(Date.parse(now) < Date.parse(artifact?.expires_at)))) errors.push('Applicable proof or OCI artifact expired at the final verdict');
  return { valid: errors.length === 0, authorized: false, errors };
}
export function inspectFinalImageFacts(facts) {
  const errors = [];
  const fail = message => errors.push(message);
  let entries;
  try { entries = readZip(facts?.proofZipBytes ?? ''); } catch (error) { fail(`Invalid proof ZIP: ${error.message}`); }
  if (entries && (entries.size !== FINAL_PROOF_FILES.length || FINAL_PROOF_FILES.some(name => !entries.has(name)))) fail('Exact closed final proof file set required');
  const json = name => { try { return JSON.parse(entries?.get(name)); } catch { fail(`Unreadable final proof ${name}`); return null; } };
  if (JSON.stringify(facts?.producer?.job?.steps?.map(step => step.name)) !== JSON.stringify(FINAL_INSPECTION_STEPS)
    || facts?.producer?.job?.steps?.some(step => step.conclusion !== 'success')) fail('Every exact inspection step must succeed; missing/skipped/extra steps fail');
  const receipt = json('forge-oci-receipt.json');
  const manifestBytes = entries?.get('forge-oci-manifest.json');
  const configBytes = entries?.get('forge-oci-config.json');
  const inspected = json('forge-scan-image-ids.json');
  let now = COLLECTED.has(facts) ? new Date().toISOString() : facts?.now;
  const binding = checkFinalImageBinding({ ...facts, receipt, manifestBytes, configBytes, inspected, now });
  errors.push(...binding.errors);
  const executionRecord = json('forge-queue-execution.json');
  if (!executionRecord || Object.keys(executionRecord).sort().join('|') !== ['sourceSha', 'workflowSha', 'repository', 'repositoryId', 'event', 'runId', 'runAttempt', 'job', 'approval'].sort().join('|')
    || executionRecord.sourceSha !== facts?.execution?.head || executionRecord.workflowSha !== facts?.execution?.head
    || executionRecord.repository !== REPOSITORY || executionRecord.repositoryId !== String(REPOSITORY_ID)
    || executionRecord.event !== 'merge_group' || executionRecord.runId !== String(facts?.producer?.run?.id)
    || executionRecord.runAttempt !== String(facts?.producer?.run?.run_attempt) || executionRecord.job !== 'inspection'
    || executionRecord.approval !== false) fail('Exact producing workflow/execution SHA and nonce required');
  const configId = inspected?.dockerConfigId;
  if (entries) {
    const content = checkQueueForgeImageContent(entries, facts?.execution?.head, { configId, manifestDigest: receipt?.manifestDigest });
    errors.push(...content.errors);
  }
  if (COLLECTED.has(facts)) {
    now = new Date().toISOString();
    errors.push(...checkFinalProofFreshness(facts.decision, facts.sourceTarget,
      [facts.artifact, facts.archiveArtifact], now).errors);
  }
  return { machineChecksPassed: COLLECTED.has(facts) && errors.length === 0,
    authenticatedProvenance: COLLECTED.has(facts), structurallyEligible: errors.length === 0,
    authorized: false, executionSha: facts?.execution?.head ?? null, errors, manifestDigest: receipt?.manifestDigest ?? null,
    archiveSha256: receipt?.archiveSha256 ?? null, validatedAtUTC: now,
    artifactExpiries: [facts?.artifact?.expires_at ?? null, facts?.archiveArtifact?.expires_at ?? null],
    limitation: 'Authentication is technical evidence only. Source policy and explicit human activation remain separate.' };
}
/** Fixed authenticated GETs, committed source target, bounded wait. No caller evidence overrides. */
export function collectFinalImageProof(repositoryRoot, options = {}) {
  if (Object.keys(options).some(key => key !== 'published') || (options.published !== undefined && typeof options.published !== 'boolean')) throw new Error('No runtime source/evidence/program overrides accepted');
  const published = options.published === true;
  repositoryRoot = resolve(repositoryRoot);
  const env = environment();
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', repositoryRoot, ...args], { env, timeout: 120000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const api = (path, raw = false) => {
    const data = execFileSync('/usr/bin/gh', ['api', '--hostname', 'github.com', '--method', 'GET', path], { env, timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return raw ? data : JSON.parse(data);
  };
  const head = git('rev-parse', 'HEAD');
  const decision = JSON.parse(git('show', `HEAD:${DECISION_PATH}`));
  const pins = JSON.parse(git('show', `HEAD:${PINS_PATH}`));
  if (!hex(head) || !hex(decision.targetSourceHead) || decision.targetSourceHead !== pins.sourceSha
    || decision.status !== 'ACTIVE' || git('status', '--porcelain', '--untracked-files=all') !== '') throw new Error('Clean exact source-policy checkout required');
  const record = checkScopedPolicyRecord(decision, new Date().toISOString(), pins.sourceSha);
  if (!record.valid) throw new Error(record.errors.join('; '));
  const currentRunId = process.env.GITHUB_RUN_ID;
  if (!/^[1-9][0-9]*$/.test(currentRunId ?? '')) throw new Error('Actual authenticated Actions execution required');
  const currentRun = api(`repos/${REPOSITORY}/actions/runs/${currentRunId}`);
  if (currentRun.head_sha !== head || currentRun.repository?.full_name !== REPOSITORY || currentRun.repository?.id !== REPOSITORY_ID
    || currentRun.head_repository?.full_name !== REPOSITORY || !['merge_group', 'push', 'workflow_dispatch'].includes(currentRun.event)) throw new Error('Execution does not bind this repository/checkout');
  const execution = { head, event: currentRun.event, repository: REPOSITORY, repositoryId: REPOSITORY_ID };
  const deadline = Date.now() + 18 * 60_000;
  let selected;
  while (true) {
    assertFinalWaitDeadline(Date.now(), deadline);
    const runs = listFinalPages(api, `repos/${REPOSITORY}/actions/workflows/forge-queue-image-inspection.yml/runs?head_sha=${head}&event=merge_group`, 'workflow_runs');
    const run = runs.filter(x => x.head_sha === head).sort((a, b) => b.id - a.id)[0];
    const jobs = run ? listFinalPages(api, `repos/${REPOSITORY}/actions/runs/${run.id}/jobs`, 'jobs') : [];
    const artifacts = run ? listFinalPages(api, `repos/${REPOSITORY}/actions/runs/${run.id}/artifacts`, 'artifacts') : [];
    selected = selectFinalInspection(runs, jobs, artifacts, head);
    if (selected.state === 'ready') break;
    if (selected.state === 'failed') throw new Error(selected.reason);
    execFileSync('/usr/bin/sleep', ['5']);
  }
  if (selected?.state !== 'ready') throw new Error('Bounded final-image inspection wait expired');
  const currentCommit = api(`repos/${REPOSITORY}/git/commits/${head}`);
  if (currentCommit.tree?.sha !== git('rev-parse', 'HEAD^{tree}')) throw new Error('Authenticated GitHub tree differs from checkout');
  ensurePinnedGitSource(git, api, decision.targetSourceHead);
  const changed = git('diff', '--name-only', decision.targetSourceHead, head).split('\n').filter(Boolean);
  if (changed.some(path => ![PINS_PATH, DECISION_PATH].includes(path))) throw new Error('Final execution differs outside the exact declarative files');
  const executedBlobs = { source: {}, current: {} };
  for (const path of FINAL_IMAGE_EXECUTED_PATHS) {
    executedBlobs.source[path] = git('rev-parse', `${decision.targetSourceHead}:${path}`);
    executedBlobs.current[path] = api(`repos/${REPOSITORY}/contents/${path}?ref=${head}`).sha;
    if (executedBlobs.current[path] !== executedBlobs.source[path]) throw new Error(`Frozen executable changed: ${path}`);
  }
  const producer = { run: selected.run, job: selected.job, executedBlobs };
  const facts = { execution, producer, decision, sourceTarget: pins.sourceSha, artifact: selected.artifact, archiveArtifact: selected.archiveArtifact,
    proofZipBytes: api(`repos/${REPOSITORY}/actions/artifacts/${selected.artifact.id}/zip`, true),
    archiveBytes: null, published: null, phase: 'prepublish', now: new Date().toISOString() };
  if (`sha256:${sha256(facts.proofZipBytes)}` !== selected.artifact.digest || facts.proofZipBytes.length !== selected.artifact.size_in_bytes) throw new Error('Proof ZIP differs from authenticated metadata');
  const entries = readZip(facts.proofZipBytes);
  if (entries.size !== FINAL_PROOF_FILES.length || FINAL_PROOF_FILES.some(name => !entries.has(name))) throw new Error('Final proof file set differs');
  const receipt = JSON.parse(entries.get('forge-oci-receipt.json'));
  const manifest = JSON.parse(entries.get('forge-oci-manifest.json'));
  // The large OCI ZIP never enters this process' memory. The helper verifies the
  // authenticated ZIP, actual tar hash, all OCI blobs and manifest/config links.
  facts.archiveVerification = JSON.parse(execFileSync('/usr/bin/python3', [resolve(repositoryRoot, 'scripts/verify-forge-oci-artifact.py')], {
    env, input: JSON.stringify({ ...selected.archiveArtifact, archiveSha256: receipt.archiveSha256,
      manifestDigest: receipt.manifestDigest, configDigest: manifest.config?.digest, sourceSha: head }),
    timeout: 660000, maxBuffer: 64 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  if (published) {
    const aws = ['/usr/local/bin/aws', '/usr/bin/aws'].find(path => { try { readFileSync(path); return true; } catch { return false; } });
    if (!aws) throw new Error('Fixed AWS CLI unavailable for authenticated registry GET');
    const image = JSON.parse(execFileSync(aws, ['ecr', 'batch-get-image', '--region', 'us-west-2', '--endpoint-url', 'https://api.ecr.us-west-2.amazonaws.com', '--registry-id', '237343248947', '--repository-name', 'oxy/oxy-api', '--image-ids', `imageTag=mq-${head}`, '--accepted-media-types', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json', '--output', 'json'], { env, timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })).images?.[0];
    if (!image?.imageManifest || image.registryId !== '237343248947') throw new Error('Exact registry image unavailable');
    facts.phase = 'published';
    facts.published = { repository: 'oxy/oxy-api', tag: `mq-${head}`, digest: image.imageId?.imageDigest, manifestBytes: Buffer.from(image.imageManifest) };
  }
  // Polling, GETs and streaming may outlive a valid starting decision/artifact.
  // Never extend their original expiry. Check again after ALL blocking work.
  facts.now = new Date().toISOString();
  const freshness = checkFinalProofFreshness(decision, pins.sourceSha,
    [facts.artifact, facts.archiveArtifact], facts.now);
  if (!freshness.valid) throw new Error(freshness.errors.join('; '));
  freeze(facts); COLLECTED.add(facts); return facts;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2];
  if (!['prepublish', 'published'].includes(phase) || process.argv.length !== 3) throw new Error('Usage: prepublish|published; no source/evidence overrides');
  const result = inspectFinalImageFacts(collectFinalImageProof(resolve(fileURLToPath(new URL('..', import.meta.url))), { published: phase === 'published' }));
  console.log(JSON.stringify(result, null, 2));
  if (!result.machineChecksPassed) process.exitCode = 1;
}
