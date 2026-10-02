/** Offline review of the UNAPPLIED workflow diff. No real policy or permissions. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINAL_PROOF_FILES, checkFinalProofFreshness } from './forge-final-image-collector.mjs';
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'forge-unapplied-dag-fixture-'));
const sha = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`;
let assertions = 0;
const check = (actual, expected, message) => { assert.equal(actual, expected, message); assertions++; };
try {
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', root, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
  git('init', '-q');
  const paths = ['.github/workflows/merge-queue-image.yml', '.github/workflows/deploy-aws.yml', '.github/workflows/ci.yml', '.github/scripts/resolve-queue-image.sh'];
  for (const path of paths) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), readFileSync(join(source, path))); }
  git('add', '--', ...paths); git('commit', '-qm', 'Synthetic baseline only');
  git('apply', '--unidiff-zero', join(source, 'docs/security/forge-candidate/queue-image-dag-preparation.diff'));
  for (const path of ['.github/workflows/merge-queue-image.yml', '.github/workflows/deploy-aws.yml', '.github/workflows/ci.yml', '.github/workflows/forge-queue-image-inspection.yml']) {
    const yaml = Bun.YAML.parse(readFileSync(join(root, path), 'utf8')); check(typeof yaml.jobs, 'object', `Valid reviewed YAML ${path}`);
  }
  const future = readFileSync(join(root, '.github/workflows/forge-queue-image-inspection.yml'), 'utf8');
  for (const file of FINAL_PROOF_FILES) check(future.includes(`runner.temp }}/${file}`), true, `Exact proof output ${file}`);
  check(future.includes('--preserve-digests'), true); check(future.includes('skopeo logout'), true);
  const pipeline = Bun.YAML.parse(future);
  check(pipeline.jobs.inspection.permissions, undefined); check(pipeline.permissions['id-token'], undefined);
  check(pipeline.jobs.publish.permissions['id-token'], 'write');
  check(pipeline.jobs.publish.needs.includes('authorize'), true);
  execFileSync('/bin/bash', ['-n', join(root, '.github/scripts/resolve-queue-image.sh')]); assertions++;
  // Real Git proves external transport preserves the exact clean-source gate.
  git('add', '--', ...paths, '.github/workflows/forge-queue-image-inspection.yml');
  git('commit', '-qm', 'Synthetic reviewed future DAG only');
  const layout = mkdtempSync(join(tmpdir(), 'forge-download-layout-'));
  try {
    for (const step of pipeline.jobs.publish.steps.filter(step => step.uses?.startsWith('actions/download-artifact'))) {
      const location = step.with.path.replace('${{ runner.temp }}', layout).replace('${{ github.run_id }}', '123');
      mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'transport-fixture.txt'), 'synthetic transport');
    }
    check(git('status', '--porcelain', '--untracked-files=all').trim(), '');
    mkdirSync(join(root, 'proof')); writeFileSync(join(root, 'proof/transport.json'), '{}');
    check(git('status', '--porcelain', '--untracked-files=all').includes('proof/transport.json'), true, 'Old workspace layout is rejected');
    rmSync(join(root, 'proof'), { recursive: true });
    check(git('status', '--porcelain', '--untracked-files=all').trim(), '');
  } finally { rmSync(layout, { recursive: true, force: true }); }
  const bin = join(root, 'bin'); mkdirSync(bin);
  const script = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
  // Explicit synthetic stand-ins exist only in this owned fixture directory.
  script('git', 'if [[ "$1" == show ]]; then cat "$FIXTURE_POLICY"; elif [[ "$*" == "rev-parse HEAD" ]]; then echo "$FIXTURE_SHA"; else exit 3; fi');
  script('gh', `if [[ "$1" == auth ]]; then
    [[ -z "\${GH_TOKEN+x}" && -z "\${GITHUB_TOKEN+x}" && -z "\${GH_CONFIG_DIR+x}" ]]
    [[ "$HOME" == "$FIXTURE_OS_HOME" ]]
    if [[ "$2" == login ]]; then read -r token || true; [[ "$token" == synthetic-token ]]; fi
    echo "$2" >> "$FIXTURE_AUTH_LOG"
    exit 0
  fi
  cat "$FIXTURE_RUNS"`); script('aws', `if [[ "$*" == *get-login-password* ]]; then echo synthetic-password;
  elif [[ "$*" == *--query* ]]; then echo "$FIXTURE_DIGEST";
  else cat "$FIXTURE_ECR"; fi`);
  script('skopeo', `if [[ "$1" == copy ]]; then echo copy >> "$FIXTURE_COPY_LOG";
  elif [[ "$1" == login ]]; then read -r password || true; [[ "$password" == synthetic-password ]]; fi`);
  script('bun', 'echo called > "$FIXTURE_CALLED"; if [[ "$FIXTURE_BUN_FAIL" == 1 ]]; then exit 1; fi; cat "$FIXTURE_PROOF"');
  const runPath = join(root, 'runs.json'), ecrPath = join(root, 'ecr.json'), proofPath = join(root, 'proof.json'), policyPath = join(root, 'policy.json'), called = join(root, 'called');
  const run = workflow => ({ status: 'completed', conclusion: 'success', event: 'merge_group', head_sha: sha, head_repository: { full_name: 'OxyHQ/oxy' }, path: `.github/workflows/${workflow}` });
  const invoke = ({ active = false, runs = undefined, proof = undefined, bunFail = false, actualSha = sha } = {}) => {
    rmSync(called, { force: true });
    writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, status: active ? 'ACTIVE' : 'INACTIVE', targetSourceHead: active ? sha : null, expiresAt: null, authorizationRecord: null, independentEvidence: null }));
    writeFileSync(runPath, JSON.stringify({ workflow_runs: runs ?? [run(active ? 'forge-queue-image-inspection.yml' : 'merge-queue-image.yml')] }));
    writeFileSync(ecrPath, JSON.stringify({ images: [{ imageId: { imageDigest: digest } }] }));
    writeFileSync(proofPath, JSON.stringify(proof ?? { authenticatedProvenance: true, machineChecksPassed: true, authorized: false, executionSha: sha, manifestDigest: digest }));
    return spawnSync('/bin/bash', [join(root, '.github/scripts/resolve-queue-image.sh')], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPOSITORY: 'oxy/oxy-api', SHA: sha, GITHUB_REPOSITORY: 'OxyHQ/oxy', GITHUB_OUTPUT: '', WAIT_SECS: '0', FIXTURE_POLICY: policyPath, FIXTURE_RUNS: runPath, FIXTURE_ECR: ecrPath, FIXTURE_PROOF: proofPath, FIXTURE_CALLED: called, FIXTURE_SHA: actualSha, FIXTURE_BUN_FAIL: bunFail ? '1' : '0' } });
  };
  let reply = invoke(); check(reply.status, 0); check(reply.stdout.trim(), `digest=${digest}`);
  reply = invoke({ runs: [] }); check(reply.status, 0); check(reply.stdout.trim(), 'digest=');
  reply = invoke({ active: true }); check(reply.status, 0); check(reply.stdout.trim(), `digest=${digest}`, 'Synthetic transport eligibility only, no live authority');
  for (const options of [
    { runs: [] }, { runs: [run('merge-queue-image.yml')] }, { actualSha: 'c'.repeat(40) }, { bunFail: true },
    ...['authenticatedProvenance', 'machineChecksPassed'].map(key => ({ proof: { authenticatedProvenance: true, machineChecksPassed: true, authorized: false, executionSha: sha, manifestDigest: digest, [key]: false } })),
    { proof: { authenticatedProvenance: true, machineChecksPassed: true, authorized: true, executionSha: sha, manifestDigest: digest } },
    { proof: { authenticatedProvenance: true, machineChecksPassed: true, authorized: false, executionSha: 'c'.repeat(40), manifestDigest: digest } },
    { proof: { authenticatedProvenance: true, machineChecksPassed: true, authorized: false, executionSha: sha, manifestDigest: `sha256:${'c'.repeat(64)}` } },
  ]) { reply = invoke({ active: true, ...options }); check(reply.status === 0, false); check(reply.stdout.includes('digest='), false); }
  // Execute the exact future shell login/cleanup commands with a stub receptor.
  // The synthetic token never reaches real gh, config storage or GitHub.
  const authLog = join(root, 'auth.log');
  const authEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'synthetic-token', GITHUB_TOKEN: 'synthetic-token', GH_CONFIG_DIR: join(root, 'untrusted-config'), FORGE_PROVENANCE_READ_TOKEN: 'synthetic-token', FIXTURE_OS_HOME: userInfo().homedir, FIXTURE_AUTH_LOG: authLog };
  const guards = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')).jobs.guards;
  for (const name of ['Security Audit: authenticate read-only provenance GETs', 'Security Audit: remove read-only provenance login']) {
    const step = guards.steps.find(step => step.name === name);
    const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', step.run], { cwd: root, encoding: 'utf8', env: authEnv });
    check(result.status, 0, result.stderr);
  }
  check(readFileSync(authLog, 'utf8'), 'login\nlogout\n');
  const deploy = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/deploy-aws.yml'), 'utf8')).jobs.deploy;
  const login = deploy.steps.find(step => step.name === 'Find the image the merge queue built').run.replace('${{ steps.forge_policy.outputs.active }}', 'true');
  // Force the actual resolver to fail after login; EXIT still logs out.
  const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', login], { cwd: root, encoding: 'utf8', env: { ...authEnv, REPOSITORY: 'oxy/oxy-api', SHA: sha, GITHUB_REPOSITORY: 'OxyHQ/oxy', FIXTURE_POLICY: policyPath, FIXTURE_RUNS: runPath, FIXTURE_ECR: ecrPath, FIXTURE_PROOF: proofPath, FIXTURE_CALLED: called, FIXTURE_SHA: sha, FIXTURE_BUN_FAIL: '1' } });
  check(result.status === 0, false); check(readFileSync(authLog, 'utf8'), 'login\nlogout\nlogin\nlogout\n');
  // Execute the exact future publication boundary. A controlled synthetic clock
  // advances during wait/stream/CI; failed final revalidation must prevent even
  // the mocked skopeo copy. This does not invoke a registry or human authority.
  const publisher = pipeline.jobs.publish.steps.find(step => step.name === 'Publish the inspected OCI bytes without rebuild').run;
  const copyLog = join(root, 'copies.log');
  const transport = mkdtempSync(join(tmpdir(), 'forge-publisher-transport-'));
  mkdirSync(join(transport, 'proof'));
  check(pipeline.jobs.publish.steps.filter(step => step.uses?.startsWith('actions/download-artifact')).every(step => step.with.path.startsWith('${{ runner.temp }}/')), true);
  writeFileSync(join(transport, 'proof/forge-oci-receipt.json'), JSON.stringify({ manifestDigest: digest }));
  const clockDecision = { schemaVersion: 1, status: 'ACTIVE', targetSourceHead: sha, expiresAt: '2026-10-02T12:30:00.000Z',
    authorizationRecord: { channel: 'explicit-user-session', reference: 'SYNTHETIC CLOCK FIXTURE ONLY', instructionSha256: 'a'.repeat(64), recordedAt: '2026-10-02T11:00:00.000Z' },
    independentEvidence: { sourceHead: sha, proofSha256: 'a'.repeat(64) } };
  const clockArtifacts = [0, 1].map(() => ({ expired: false, expires_at: '2026-10-02T13:00:00.000Z' }));
  writeFileSync(proofPath, JSON.stringify({ authenticatedProvenance: true, machineChecksPassed: true, authorized: false, executionSha: sha, manifestDigest: digest }));
  for (const phase of ['valid', 'wait', 'streaming', 'CI']) {
    rmSync(copyLog, { force: true });
    check(checkFinalProofFreshness(clockDecision, sha, clockArtifacts, '2026-10-02T12:00:00.000Z').valid, true);
    const fresh = checkFinalProofFreshness(clockDecision, sha, clockArtifacts,
      phase === 'valid' ? '2026-10-02T12:20:00.000Z' : '2026-10-02T12:30:00.000Z');
    const boundary = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', publisher], { cwd: root, encoding: 'utf8', env: {
      ...authEnv, FORGE_TRANSPORT_DIR: transport, ECR_REGISTRY: 'synthetic-registry.invalid', GITHUB_SHA: sha, FIXTURE_COPY_LOG: copyLog, FIXTURE_DIGEST: digest,
      FIXTURE_PROOF: proofPath, FIXTURE_ECR: ecrPath, FIXTURE_CALLED: called, FIXTURE_BUN_FAIL: fresh.valid ? '0' : '1',
    } });
    check(boundary.status === 0, fresh.valid, boundary.stderr);
    const copies = (() => { try { return readFileSync(copyLog, 'utf8'); } catch { return ''; } })();
    check(copies, fresh.valid ? 'copy\n' : '', `No publication after expiry during ${phase}`);
  }
  rmSync(transport, { recursive: true, force: true });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`${assertions} unapplied DAG/resolver assertions pass in synthetic owned Git only; authorized:false.`);
