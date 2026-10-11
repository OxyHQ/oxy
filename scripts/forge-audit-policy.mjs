/** A disabled policy candidate. Human authorization is a separate session decision. */
import { checkScopedPolicyRecord } from './forge-policy-record.mjs';
import { collectFinalImageProof, inspectFinalImageFacts } from './forge-final-image-collector.mjs';
import { checkFrozenSourceTopology } from './forge-source-topology.mjs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import {
  ADVISORY,
  TRUSTED_BASELINE,
  TRUSTED_WORKFLOW,
  PINS_PATH,
  canonicalAudit,
  collect,
  evaluate,
  inventory,
  sha256,
  collectIndependentInputObjects,
  INDEPENDENT_INPUT_PATHS,
} from './forge-remediation-proof-proposal.mjs';

export const DECISION_PATH = 'docs/security/forge-candidate/provenance/audit-policy-decision.json';
export const DECLARATIVE_PATHS = Object.freeze([PINS_PATH, DECISION_PATH]);
export const EVIDENCE_PATH = 'docs/security/forge-independent/2026-10-03-final-input/proof.json';
export { INDEPENDENT_INPUT_PATHS } from './forge-remediation-proof-proposal.mjs';
const RECORD_NAMES = Object.freeze([
  'expo-14.log',
  'oxy-db-build.log',
  'stock-install-pinned.log',
  'candidate-install.log',
  'oxy-install.log',
  'stock-build.log',
  'candidate-build-1.log',
  'candidate-build-2.log',
  'candidate-build-3.log',
  'stock-upstream.log',
  'candidate-upstream.log',
  'expo-14-final.log',
  'oxy-34.log',
  'stock-controls.json',
  'candidate-controls.json',
  'hashes-after-build-2.json',
  'candidate-build-repeat.json',
]);
const EXECUTED_PATHS = Object.freeze([
  '.github/workflows/ci.yml',
  'scripts/check-dependency-audit.mjs',
  'scripts/forge-audit-policy.mjs',
  'scripts/test-forge-audit-policy.mjs',
  'scripts/test-forge-independent-inputs.mjs',
  'scripts/test-check-dependency-audit.mjs',
  'scripts/forge-policy-test-fixtures.mjs',
  'scripts/forge-source-topology.mjs',
  'scripts/test-forge-source-topology.mjs',
  'scripts/forge-final-image-binding.mjs',
  'scripts/test-forge-final-image-binding.mjs',
  'scripts/forge-final-image-collector.mjs',
  'scripts/test-forge-final-image-collector.mjs',
  'scripts/forge-final-image-test-fixture.mjs',
  'scripts/test-forge-final-image-live-clock.mjs',
  'scripts/forge-policy-record.mjs',
  'scripts/test-forge-future-dag.mjs',
  'scripts/check-published-forge-image.mjs',
  'scripts/verify-forge-oci-artifact.py',
  'scripts/test-verify-forge-oci-artifact.py',
  ...TRUSTED_WORKFLOW.executedPaths,
]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && canonicalAudit(Object.keys(value).sort()) === canonicalAudit([...keys].sort());
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const iso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const same = (a, b) => canonicalAudit(a) === canonicalAudit(b);

/** Structural validation only. Caller objects never prove a human decision or authorize audit. */
export function checkForgePolicyStructure(input) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const {
    decision,
    audit,
    facts,
    proposal,
    proofBytes,
    recordBytes,
    copies,
    blobs,
    independentInputs,
    finalImageProof,
    now,
  } = input;
  if (
    !exact(decision, [
      'schemaVersion',
      'status',
      'targetSourceHead',
      'expiresAt',
      'authorizationRecord',
      'independentEvidence',
    ]) ||
    decision.schemaVersion !== 1 ||
    !['INACTIVE', 'ACTIVE'].includes(decision.status)
  )
    fail('Invalid closed policy schema');
  if (decision?.status !== 'ACTIVE') fail('Scoped policy is inactive');
  if (!commit(decision?.targetSourceHead) || decision.targetSourceHead !== facts?.pins?.sourceSha)
    fail('Target must equal immutable evidence source');
  const authorization = decision?.authorizationRecord;
  if (
    !exact(authorization, ['channel', 'reference', 'instructionSha256', 'recordedAt']) ||
    authorization.channel !== 'explicit-user-session' ||
    typeof authorization.reference !== 'string' ||
    authorization.reference.trim().length < 10 ||
    !hash(authorization.instructionSha256) ||
    !iso(authorization.recordedAt)
  )
    fail('Missing separately recorded explicit session decision');
  // The record is reviewed policy data, NOT a machine assertion that a person authored it.
  if (
    !iso(now) ||
    !iso(decision?.expiresAt) ||
    Date.parse(decision.expiresAt) <= Date.parse(now) ||
    !iso(authorization?.recordedAt) ||
    Date.parse(authorization.recordedAt) > Date.parse(now) ||
    Date.parse(decision.expiresAt) > Date.parse(authorization.recordedAt) + 7 * 86400_000
  )
    fail('Policy timing is invalid, expired or exceeds seven days');
  if (
    typeof canonicalAudit(audit) !== 'string' ||
    sha256(canonicalAudit(audit)) !== TRUSTED_BASELINE.rawAuditSha256
  )
    fail('Whole live audit differs from pinned baseline');
  const advisories = audit?.['node-forge'];
  if (
    !Array.isArray(advisories) ||
    advisories.length !== 1 ||
    advisories[0]?.url !== TRUSTED_BASELINE.advisoryUrl ||
    advisories[0]?.severity !== 'high' ||
    advisories[0]?.vulnerable_versions !== '<=1.4.0'
  )
    fail('Exact single Forge high advisory required');
  if (
    facts?.github?.artifact?.expired !== false ||
    !(Date.parse(now) < Date.parse(facts?.github?.artifact?.expires_at))
  )
    fail('Original authenticated artifact expired at the final policy verdict');
  if (
    proposal?.authenticatedProvenance !== true ||
    proposal?.machineChecksPassed !== true ||
    proposal?.approved !== false ||
    proposal?.proposalOnly !== true ||
    proposal?.errors?.length !== 0
  )
    fail('Authenticated candidate machine proof is incomplete');
  const topology = checkFrozenSourceTopology(facts?.git, facts?.pins);
  for (const error of topology.errors) fail(error);
  // Queue source equivalence is separate from its image. PR artifact never proves
  // the queue image: the future no-publish build/scan/Guards/publish DAG must supply it.
  const execution = facts?.git?.currentGithub?.run;
  if (
    topology.kind === 'squash' ||
    ['merge_group', 'push', 'workflow_dispatch'].includes(execution?.event)
  ) {
    if (
      finalImageProof?.machineChecksPassed !== true ||
      finalImageProof?.authenticatedProvenance !== true ||
      finalImageProof.executionSha !== facts?.git?.head ||
      !Array.isArray(finalImageProof.artifactExpiries) ||
      finalImageProof.artifactExpiries.length !== 2 ||
      finalImageProof.artifactExpiries.some((expiry) => !(Date.parse(now) < Date.parse(expiry)))
    )
      fail(
        'Own authenticated execution image proof required; PR image cannot authorize queue/main publication',
      );
  }
  if (
    !Array.isArray(facts?.git?.changedPaths) ||
    facts.git.changedPaths.some((path) => !DECLARATIVE_PATHS.includes(path))
  )
    fail('Only the two exact declarative paths may differ from target');
  for (const path of EXECUTED_PATHS)
    if (!blobs?.source?.[path] || blobs.source[path] !== blobs?.current?.[path])
      fail(`Executed code changed: ${path}`);
  if (!Array.isArray(copies) || copies.length === 0) fail('Installed Forge inventory is missing');
  else
    for (const copy of copies)
      if (copy.version !== '1.4.0' || !same(copy.files, TRUSTED_BASELINE.files))
        fail('An installed Forge copy differs from pinned bytes');
  const evidence = decision?.independentEvidence;
  if (
    !exact(evidence, ['sourceHead', 'proofSha256']) ||
    !commit(evidence.sourceHead) ||
    !hash(evidence.proofSha256) ||
    !proofBytes ||
    sha256(proofBytes) !== evidence.proofSha256
  )
    fail('Independent evidence digest/source missing or mismatched');
  let proof;
  try {
    proof = JSON.parse(proofBytes);
  } catch {
    fail('Independent proof is unreadable');
  }
  if (
    proof?.candidateCommit !== evidence?.sourceHead ||
    proof?.securityApproved !== false ||
    proof?.auditExceptionApproved !== false ||
    proof?.noPrivateKeyForgeryDemonstrated !== false ||
    proof?.status !== 'INDEPENDENT_REPRODUCTION_COMPLETED_CANDIDATE_UNAPPROVED'
  )
    fail('Independent evidence identity or limits changed');
  for (const path of INDEPENDENT_INPUT_PATHS)
    if (
      !independentInputs?.reviewed?.[path] ||
      independentInputs.reviewed[path] !== independentInputs?.target?.[path]
    )
      fail(`Independent suite input changed: ${path}`);
  if (
    !same(proof?.files?.candidate, TRUSTED_BASELINE.files) ||
    !same(proof?.files?.installed, TRUSTED_BASELINE.files) ||
    proof?.inputs?.['patches/node-forge@1.4.0.patch'] !== TRUSTED_BASELINE.patchSha256 ||
    proof?.candidateBuilds2And3ByteIdentical !== true
  )
    fail('Independent candidate bytes or rebuild parity differ');
  if (
    proof?.upstreamTests?.stock?.passing !== 828 ||
    proof?.upstreamTests?.candidate?.passing !== 828 ||
    proof?.upstreamTests?.stock?.pending !== 4 ||
    proof?.upstreamTests?.candidate?.pending !== 4 ||
    proof?.expoTests?.ownPublicApiChecksPassing !== 14 ||
    proof?.oxyTests?.testsPassing !== 34 ||
    proof?.knownKeyControls?.stock?.count !== 321 ||
    proof?.knownKeyControls?.candidate?.count !== 321
  )
    fail('Independent suite coverage differs from specifically reviewed scope');
  const requiredRecords = [
    'stock-build.log',
    'candidate-build-1.log',
    'candidate-build-2.log',
    'candidate-build-3.log',
    'stock-upstream.log',
    'candidate-upstream.log',
    'expo-14-final.log',
    'oxy-34.log',
    'stock-controls.json',
    'candidate-controls.json',
    'hashes-after-build-2.json',
    'candidate-build-repeat.json',
  ];
  if (!Array.isArray(proof?.records) || proof.records.length !== 17)
    fail('Independent raw records are incomplete');
  else {
    const seen = new Set();
    for (const record of proof.records) {
      if (
        typeof record.file !== 'string' ||
        !RECORD_NAMES.includes(record.file) ||
        seen.has(record.file) ||
        !hash(record.sha256) ||
        !recordBytes?.[record.file] ||
        sha256(recordBytes[record.file]) !== record.sha256
      )
        fail('Independent raw record missing, unsafe, duplicate or modified');
      seen.add(record.file);
    }
    for (const name of requiredRecords)
      if (proof.records.find((record) => record.file === name)?.exitCode !== 0)
        fail(`Required suite record did not succeed: ${name}`);
  }
  return {
    structurallyEligible: errors.length === 0,
    authorized: false,
    errors,
    limitation:
      'Caller records cannot authenticate a human; activation requires a separate explicit user instruction and reviewed source policy change.',
  };
}

function gitReader(repositoryRoot) {
  const env = { ...process.env, HOME: userInfo().homedir };
  for (const key of Object.keys(env))
    if (/^(GIT_|GH_|GITHUB_|BUN_|NPM_CONFIG_|XDG_CONFIG_HOME$)/i.test(key)) delete env[key];
  return (...args) =>
    execFileSync('/usr/bin/git', ['-C', repositoryRoot, ...args], {
      env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** CI setup predicate only; it never grants an audit exception. */
export function readCommittedPolicyStatus() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const decision = JSON.parse(gitReader(repositoryRoot)('show', `HEAD:${DECISION_PATH}`));
  const record = checkScopedPolicyRecord(decision, new Date().toISOString());
  if (!record.valid) throw new Error(record.errors.join('; '));
  return decision.status;
}

/** Only this action-time path can inspect real provenance; no caller decision/input override. */
export function inspectForgeAuditPolicy(audit, options = {}) {
  if (
    Object.keys(options).some((key) => key !== 'publishedImage') ||
    (options.publishedImage !== undefined && typeof options.publishedImage !== 'boolean')
  )
    throw new Error('No source, evidence or clock overrides accepted');
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = gitReader(repositoryRoot);
  let decision;
  try {
    decision = JSON.parse(git('show', `HEAD:${DECISION_PATH}`));
  } catch {
    return {
      remediated: false,
      configurationInvalid: true,
      reason: 'Scoped policy record unavailable',
    };
  }
  if (
    !exact(decision, [
      'schemaVersion',
      'status',
      'targetSourceHead',
      'expiresAt',
      'authorizationRecord',
      'independentEvidence',
    ]) ||
    decision.schemaVersion !== 1 ||
    !['INACTIVE', 'ACTIVE'].includes(decision.status)
  ) {
    return { remediated: false, configurationInvalid: true, reason: 'Invalid closed policy JSON' };
  }
  if (decision.status === 'INACTIVE') {
    if (
      ['targetSourceHead', 'expiresAt', 'authorizationRecord', 'independentEvidence'].some(
        (key) => decision[key] !== null,
      )
    ) {
      return {
        remediated: false,
        configurationInvalid: true,
        reason: 'Inactive policy must contain no decision or evidence claim',
      };
    }
    return {
      remediated: false,
      policyActive: false,
      reason: 'Scoped policy is inactive; no authorization inferred',
    };
  }
  const record = checkScopedPolicyRecord(decision, new Date().toISOString());
  if (!record.valid)
    return {
      remediated: false,
      configurationInvalid: true,
      policyActive: true,
      reason: record.errors.join('; '),
    };
  // Audit fixtures can never activate the real gate, even when policy is later enabled.
  if (process.env.DEPENDENCY_AUDIT_INPUT !== undefined)
    return {
      remediated: false,
      policyActive: true,
      reason: 'Injected audit payload cannot authorize remediation',
    };
  try {
    const facts = collect({ repoRoot: repositoryRoot });
    if (!same(facts.audit, audit)) throw new Error('Audit changed between checks');
    const target = decision.targetSourceHead;
    const blobs = { source: {}, current: {} };
    for (const path of EXECUTED_PATHS) {
      blobs.source[path] = git('rev-parse', `${target}:${path}`).toString().trim();
      blobs.current[path] = git('rev-parse', `HEAD:${path}`).toString().trim();
    }
    // Evidence and log bytes belong to the frozen target, never a mutable caller path.
    const proofBytes = git('show', `${target}:${EVIDENCE_PATH}`);
    const proof = JSON.parse(proofBytes);
    const recordBytes = Object.fromEntries(
      proof.records.map((record) => {
        if (typeof record.file !== 'string' || !RECORD_NAMES.includes(record.file))
          throw new Error('Unsafe evidence record path');
        return [record.file, git('show', `${target}:${join(dirname(EVIDENCE_PATH), record.file)}`)];
      }),
    );
    const independentInputs = {
      reviewed: collectIndependentInputObjects(proof.candidateCommit),
      target: {},
    };
    for (const path of INDEPENDENT_INPUT_PATHS) {
      independentInputs.target[path] = git('rev-parse', `${target}:${path}`).toString().trim();
    }
    const execution = facts.git.currentGithub?.run;
    const finalFacts =
      !facts.git.sourceIsAncestor ||
      ['merge_group', 'push', 'workflow_dispatch'].includes(execution?.event)
        ? collectFinalImageProof(repositoryRoot, { published: options.publishedImage === true })
        : null;
    const copies = inventory(repositoryRoot);
    const proposal = evaluate(facts); // Fresh live expiry; original approved:false unchanged.
    const finalImageProof = finalFacts ? inspectFinalImageFacts(finalFacts) : null;
    const check = checkForgePolicyStructure({
      decision,
      audit: facts.audit,
      facts,
      proposal,
      proofBytes,
      recordBytes,
      copies,
      blobs,
      independentInputs,
      finalImageProof,
      now: new Date().toISOString(),
    });
    if (!check.structurallyEligible)
      return { remediated: false, policyActive: true, reason: check.errors.join('; ') };
    // This trusts the separately reviewed SOURCE POLICY, not JSON supplied by a caller,
    // an actor name, a GitHub comment or a prototype's approved flag. Editing ACTIVE
    // is prohibited until the user explicitly authorizes that concrete decision.
    return {
      remediated: true,
      policyActive: true,
      advisory: ADVISORY,
      finalImageProof,
      reason:
        'Reviewed source policy matches the scoped machine and independent checks; the original proposal remains unapproved',
    };
  } catch (error) {
    return {
      remediated: false,
      policyActive: true,
      reason: `Strict policy validation failed: ${error.message.split('\n')[0]}`,
    };
  }
}
