/** Runs the EXACT collector source in an isolated Node VM. No live API or runtime injection hook. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync as realExec } from 'node:child_process';
import { tmpdir } from 'node:os';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fixture, head, zip } from './forge-final-image-test-fixture.mjs';
import { PINS_PATH, readZip, sha256 } from './forge-remediation-proof-proposal.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'scripts/forge-final-image-collector.mjs'), 'utf8');
const start = Date.parse('2026-10-02T12:00:00.000Z');
let assertions = 0;
async function run({
  phase,
  expire = true,
  dirty = false,
  staleMutation = false,
  artifactIndex = null,
  producerAttempt = 1,
  carryPrevious = false,
}) {
  let clock = start,
    slept = false,
    calls = 0;
  const data = fixture();
  if (producerAttempt !== 1) {
    data.producer.run.run_attempt = producerAttempt;
    data.producer.job.run_attempt = producerAttempt;
    if (!carryPrevious) {
      data.artifact.name = `forge-queue-proof-${head}-123-${producerAttempt}`;
      data.archiveArtifact.name = `forge-queue-oci-${head}-123-${producerAttempt}`;
      const entries = readZip(data.proofZipBytes),
        execution = JSON.parse(entries.get('forge-queue-execution.json'));
      execution.runAttempt = String(producerAttempt);
      entries.set('forge-queue-execution.json', Buffer.from(JSON.stringify(execution)));
      data.proofZipBytes = zip(entries);
      data.artifact.digest = `sha256:${sha256(data.proofZipBytes)}`;
      data.artifact.size_in_bytes = data.proofZipBytes.length;
    }
  }
  const decision = {
    schemaVersion: 1,
    status: 'ACTIVE',
    targetSourceHead: head,
    expiresAt: '2026-10-02T12:01:00.000Z',
    authorizationRecord: {
      channel: 'explicit-user-session',
      reference: 'SYNTHETIC CLOCK FIXTURE ONLY',
      instructionSha256: 'a'.repeat(64),
      recordedAt: '2026-10-02T11:00:00.000Z',
    },
    independentEvidence: { sourceHead: head, proofSha256: 'a'.repeat(64) },
  };
  if (artifactIndex !== null) {
    decision.expiresAt = '2026-10-02T12:05:00.000Z';
    [data.artifact, data.archiveArtifact][artifactIndex].expires_at = '2026-10-02T12:01:00.000Z';
  }
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  }
  const advance = () => {
    clock = start + (expire ? 60_000 : 59_000);
  };
  const execFileSync = (program, args) => {
    calls++;
    if (program === '/usr/bin/git') {
      const a = args.slice(2);
      if (a[0] === 'cat-file') return '';
      if (a[0] === 'status') return dirty ? '?? proof/transport.json' : '';
      if (a[0] === 'show')
        return JSON.stringify(a[1].endsWith(PINS_PATH) ? { sourceSha: head } : decision);
      if (a[0] === 'diff') return '';
      if (a[0] === 'rev-parse')
        return a[1] === 'HEAD' || a[1] === `${head}^{commit}` ? head : 'b'.repeat(40);
    }
    if (program === '/usr/bin/sleep') {
      slept = true;
      if (carryPrevious) clock += 19 * 60_000;
      else advance();
      return Buffer.alloc(0);
    }
    if (program === '/usr/bin/python3') {
      if (phase === 'stream') advance();
      return Buffer.from(JSON.stringify(data.archiveVerification));
    }
    if (program === '/usr/bin/gh') {
      const path = args.at(-1);
      let reply;
      if (path.endsWith('/runs/77')) reply = { ...data.producer.run, id: 77 };
      else if (path.includes('/contents/')) reply = { sha: 'b'.repeat(40) };
      else if (path.includes('/workflows/'))
        reply = { workflow_runs: phase === 'wait' && !slept ? [] : [data.producer.run] };
      else if (path.includes('/jobs?')) reply = { jobs: [data.producer.job] };
      else if (path.includes('/artifacts?'))
        reply = { artifacts: [data.artifact, data.archiveArtifact] };
      else if (path.endsWith('/git/commits/' + head))
        reply = { sha: head, tree: { sha: 'b'.repeat(40) } };
      else if (path.includes('/contents/')) reply = { sha: 'b'.repeat(40) };
      else if (path.endsWith('/456/zip')) return data.proofZipBytes;
      else throw new Error('Unexpected isolated GET ' + path);
      return Buffer.from(JSON.stringify(reply));
    }
    throw new Error('Unexpected isolated command ' + program + ' ' + args.join(' '));
  };
  const context = createContext({
    Date: Clock,
    Buffer,
    console,
    URL,
    process: { env: { GITHUB_RUN_ID: '77' }, argv: [] },
  });
  const module = new SourceTextModule(
    staleMutation
      ? source.replace('facts.now = new Date().toISOString();', 'facts.now = facts.now;')
      : source,
    {
      context,
      identifier: join(root, 'scripts/forge-final-image-collector.mjs'),
      initializeImportMeta(meta) {
        meta.url = new URL('scripts/forge-final-image-collector.mjs', 'file://' + root + '/').href;
      },
    },
  );
  await module.link(async (specifier) => {
    const values =
      specifier === 'node:child_process'
        ? { execFileSync }
        : await import(
            specifier.startsWith('.')
              ? new URL(specifier, 'file://' + root + '/scripts/').href
              : specifier
          );
    const names = Object.keys(values);
    return new SyntheticModule(
      names,
      function () {
        for (const name of names) this.setExport(name, values[name]);
      },
      { context },
    );
  });
  await module.evaluate();
  let facts;
  try {
    facts = module.namespace.collectFinalImageProof(root);
  } catch (error) {
    return { error, calls, slept };
  }
  if (phase === 'verdict') advance();
  return { facts, verdict: module.namespace.inspectFinalImageFacts(facts), calls, slept };
}
for (const phase of ['wait', 'stream']) {
  const valid = await run({ phase, expire: false });
  assert.equal(valid.verdict?.machineChecksPassed, true, valid.error?.message);
  assertions++;
  const expired = await run({ phase });
  assert.match(expired.error?.message ?? '', /expired|timing/i, phase);
  assertions++;
  if (phase === 'wait') {
    assert.equal(expired.slept, true);
    assertions++;
  }
  // Mutation executes identical real collector with ONLY final clock refresh removed.
  if (phase === 'stream') {
    const stale = await run({ phase, staleMutation: true });
    assert.equal(stale.error, undefined, 'Mutation must demonstrate obsolete collector acceptance');
    assert.ok(stale.facts, 'Obsolete collector returns facts past expiry');
    assertions += 2;
  }
}
for (const artifactIndex of [0, 1]) {
  const result = await run({ phase: 'stream', artifactIndex });
  assert.match(result.error?.message ?? '', /artifact expired/i);
  assertions++;
}
const verdict = await run({ phase: 'verdict' });
assert.equal(verdict.verdict.machineChecksPassed, false);
assert.match(verdict.verdict.errors.join(' '), /expired|timing/i);
assertions += 2;
const dirty = await run({ phase: 'none', dirty: true });
assert.match(dirty.error?.message ?? '', /Clean exact/);
assert.equal(dirty.calls, 4);
assertions += 2;
const carriedAttempt = await run({
  phase: 'none',
  expire: false,
  producerAttempt: 2,
  carryPrevious: true,
});
assert.match(carriedAttempt.error?.message ?? '', /wait expired/);
assertions++;
const freshAttempt = await run({ phase: 'none', expire: false, producerAttempt: 2 });
assert.equal(freshAttempt.verdict?.machineChecksPassed, true, freshAttempt.error?.message);
assertions++;
// Exercise the complete candidate collector after a real squash/clean single-
// branch clone. Git operations and object transport are real; GitHub/Bun are
// isolated VM fixtures. Production collect() accepts no transport override.
{
  const owned = mkdtempSync(join(tmpdir(), 'forge-source-availability-'));
  const origin = join(owned, 'origin'),
    remote = join(owned, 'remote.git');
  mkdirSync(origin);
  const git = (dir, ...args) =>
    realExec(
      '/usr/bin/git',
      [
        '-C',
        dir,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const put = (path, value) => {
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), value);
    git(origin, 'add', '--', path);
  };
  try {
    git(origin, 'init', '--initial-branch=main');
    put('README', 'isolated fixture');
    git(origin, 'commit', '-qm', 'base');
    const base = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-b', 'candidate');
    put('package.json', JSON.stringify({ packageManager: 'bun@1.4.2' }));
    put('patches/node-forge@1.4.0.patch', 'synthetic patch');
    put('bun.lock', 'synthetic lock');
    put('docs/security/forge-candidate/candidate-hashes.json', '{}');
    git(origin, 'commit', '-qm', 'frozen');
    const frozen = git(origin, 'rev-parse', 'HEAD');
    put(
      PINS_PATH,
      JSON.stringify({
        sourceSha: frozen,
        workflowMergeSha: base,
        runId: 91,
        jobId: 92,
        artifactId: 93,
      }),
    );
    git(origin, 'commit', '-qm', 'pins');
    git(origin, 'checkout', 'main');
    git(origin, 'merge', '--squash', 'candidate');
    git(origin, 'commit', '-qm', 'squash');
    const current = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'update-ref', 'refs/pull/1/head', frozen);
    git(origin, 'branch', '-D', 'candidate');
    git(origin, 'clone', '--bare', origin, remote);
    git(remote, 'update-ref', 'refs/pull/1/head', frozen);
    const commit = (sha) => ({
      sha,
      tree: { sha: git(origin, 'rev-parse', `${sha}^{tree}`) },
      parents: git(origin, 'show', '-s', '--format=%P', sha)
        .split(' ')
        .filter(Boolean)
        .map((sha) => ({ sha })),
    });
    const newSource = readFileSync(
      join(root, 'scripts/forge-remediation-proof-proposal.mjs'),
      'utf8',
    );
    const oldSource = realExec(
      '/usr/bin/git',
      [
        '-C',
        root,
        'show',
        '82bca73efa870b013d7817aac7b7f9d63799963b:scripts/forge-remediation-proof-proposal.mjs',
      ],
      { encoding: 'utf8' },
    );
    for (const mode of ['frozen-red', 'current', 'wrong-sha', 'wrong-tree']) {
      const checkout = join(owned, mode);
      git(origin, 'clone', '--single-branch', '--no-local', remote, checkout);
      assert.throws(() => git(checkout, 'cat-file', '-e', `${frozen}^{commit}`));
      assertions++;
      let fetches = 0,
        authenticatedSourceRead = false;
      const execFileSync = (program, args, options) => {
        if (program === '/usr/bin/git') {
          let actual = args;
          if (args[2] === 'fetch') {
            assert.equal(authenticatedSourceRead, true);
            assert.equal(
              JSON.stringify(args.slice(2)),
              JSON.stringify([
                'fetch',
                '--no-tags',
                '--no-write-fetch-head',
                'https://github.com/OxyHQ/oxy.git',
                frozen,
              ]),
            );
            fetches++;
            actual = args.map((value) =>
              value === 'https://github.com/OxyHQ/oxy.git' ? remote : value,
            );
          }
          return realExec(program, actual, options);
        }
        if (program === '/usr/bin/gh') {
          assert.equal(
            JSON.stringify(args.slice(0, 5)),
            JSON.stringify(['api', '--hostname', 'github.com', '--method', 'GET']),
          );
          const path = args.at(-1);
          let value;
          if (path.includes('/git/commits/')) {
            value = commit(path.split('/').at(-1));
            if (path.endsWith('/' + frozen)) {
              authenticatedSourceRead = true;
              if (mode === 'wrong-sha') value.sha = base;
              if (mode === 'wrong-tree') value.tree.sha = commit(base).tree.sha;
            }
          } else if (path.endsWith('/actions/runs/77'))
            value = { event: 'merge_group', head_sha: current };
          else if (path.endsWith('/actions/runs/91')) value = { pull_requests: [{}] };
          else if (
            path.endsWith('/actions/jobs/92') ||
            path.endsWith('/actions/artifacts/93') ||
            path.startsWith('/advisories/')
          )
            value = {};
          else if (path.includes('/contents/')) value = { sha: 'b'.repeat(40) };
          else if (path.endsWith('/actions/artifacts/93/zip'))
            return Buffer.from('synthetic ZIP transport only');
          else throw new Error('Unexpected candidate fixture GET ' + path);
          return Buffer.from(JSON.stringify(value));
        }
        if (args.join(' ') === '--version') return Buffer.from('1.4.2\n');
        if (args.join(' ') === 'audit --json') return Buffer.from('{}');
        throw new Error('Unexpected candidate fixture command ' + program);
      };
      const context = createContext({
        Buffer,
        console,
        URL,
        process: { env: { GITHUB_RUN_ID: '77' }, argv: [], cwd: () => checkout },
      });
      const module = new SourceTextModule(mode === 'frozen-red' ? oldSource : newSource, {
        context,
        identifier: join(root, 'scripts/forge-remediation-proof-proposal.mjs'),
        initializeImportMeta(meta) {
          meta.url = new URL(
            'scripts/forge-remediation-proof-proposal.mjs',
            'file://' + root + '/',
          ).href;
        },
      });
      await module.link(async (specifier) => {
        const values =
          specifier === 'node:child_process'
            ? { execFileSync }
            : await import(
                specifier.startsWith('.')
                  ? new URL(specifier, 'file://' + root + '/scripts/').href
                  : specifier
              );
        return new SyntheticModule(
          Object.keys(values),
          function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
          },
          { context },
        );
      });
      await module.evaluate();
      if (mode === 'current') {
        const facts = module.namespace.collect({ repoRoot: checkout });
        assert.equal(facts.git.clean, true);
        assert.equal(facts.git.sourceIsAncestor, false);
        assert.equal(JSON.stringify(facts.git.changedPaths), JSON.stringify([PINS_PATH]));
        assert.equal(fetches, 1);
        assert.equal(git(checkout, 'rev-parse', 'HEAD'), current);
        assert.equal(git(checkout, 'status', '--porcelain'), '');
        assert.equal(git(checkout, 'branch', '--list', 'candidate'), '');
        assertions += 7;
      } else {
        assert.throws(
          () => module.namespace.collect({ repoRoot: checkout }),
          mode === 'frozen-red' ? /git.*diff/s : /pinned source|authenticated commit/i,
        );
        assertions++;
        if (mode === 'wrong-sha') {
          assert.equal(fetches, 0);
          assertions++;
        }
      }
    }
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
}
console.log(
  `${assertions} isolated real-collector clock/layout assertions pass; stale-clock mutation accepts expired facts and corrected collector rejects. No live API, authority or publication.`,
);
