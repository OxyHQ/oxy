/** Runs the EXACT collector source in an isolated Node VM. No live API or runtime injection hook. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fixture, head } from './forge-final-image-test-fixture.mjs';
import { PINS_PATH } from './forge-remediation-proof-proposal.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'scripts/forge-final-image-collector.mjs'), 'utf8');
const start = Date.parse('2026-10-02T12:00:00.000Z');
let assertions = 0;
async function run({ phase, expire = true, dirty = false, staleMutation = false, artifactIndex = null }) {
  let clock = start, slept = false, calls = 0;
  const data = fixture();
  const decision = { schemaVersion: 1, status: 'ACTIVE', targetSourceHead: head,
    expiresAt: '2026-10-02T12:01:00.000Z', authorizationRecord: { channel: 'explicit-user-session', reference: 'SYNTHETIC CLOCK FIXTURE ONLY', instructionSha256: 'a'.repeat(64), recordedAt: '2026-10-02T11:00:00.000Z' },
    independentEvidence: { sourceHead: head, proofSha256: 'a'.repeat(64) } };
  if (artifactIndex !== null) {
    decision.expiresAt = '2026-10-02T12:05:00.000Z';
    [data.artifact, data.archiveArtifact][artifactIndex].expires_at = '2026-10-02T12:01:00.000Z';
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const advance = () => { clock = start + (expire ? 60_000 : 59_000); };
  const execFileSync = (program, args) => {
    calls++;
    if (program === '/usr/bin/git') {
      const a = args.slice(2);
      if (a[0] === 'status') return dirty ? '?? proof/transport.json' : '';
      if (a[0] === 'show') return JSON.stringify(a[1].endsWith(PINS_PATH) ? { sourceSha: head } : decision);
      if (a[0] === 'diff') return '';
      if (a[0] === 'rev-parse') return a[1] === 'HEAD' ? head : 'b'.repeat(40);
    }
    if (program === '/usr/bin/sleep') { slept = true; advance(); return Buffer.alloc(0); }
    if (program === '/usr/bin/python3') { if (phase === 'stream') advance(); return Buffer.from(JSON.stringify(data.archiveVerification)); }
    if (program === '/usr/bin/gh') {
      const path = args.at(-1); let reply;
      if (path.endsWith('/runs/77')) reply = { ...data.producer.run, id: 77 };
      else if (path.includes('/contents/')) reply = { sha: 'b'.repeat(40) };
      else if (path.includes('/workflows/')) reply = { workflow_runs: phase === 'wait' && !slept ? [] : [data.producer.run] };
      else if (path.includes('/jobs?')) reply = { jobs: [data.producer.job] };
      else if (path.includes('/artifacts?')) reply = { artifacts: [data.artifact, data.archiveArtifact] };
      else if (path.endsWith('/git/commits/' + head)) reply = { tree: { sha: 'b'.repeat(40) } };
      else if (path.includes('/contents/')) reply = { sha: 'b'.repeat(40) };
      else if (path.endsWith('/456/zip')) return data.proofZipBytes;
      else throw new Error('Unexpected isolated GET ' + path);
      return Buffer.from(JSON.stringify(reply));
    }
    throw new Error('Unexpected isolated command ' + program + ' ' + args.join(' '));
  };
  const context = createContext({ Date: Clock, Buffer, console, URL,
    process: { env: { GITHUB_RUN_ID: '77' }, argv: [] } });
  const module = new SourceTextModule(staleMutation ? source.replace('facts.now = new Date().toISOString();', 'facts.now = facts.now;') : source,
    { context, identifier: join(root, 'scripts/forge-final-image-collector.mjs'), initializeImportMeta(meta) { meta.url = new URL('scripts/forge-final-image-collector.mjs', 'file://' + root + '/').href; } });
  await module.link(async specifier => {
    const values = specifier === 'node:child_process' ? { execFileSync } : await import(specifier.startsWith('.') ? new URL(specifier, 'file://' + root + '/scripts/').href : specifier);
    const names = Object.keys(values); return new SyntheticModule(names, function () { for (const name of names) this.setExport(name, values[name]); }, { context });
  });
  await module.evaluate();
  let facts;
  try { facts = module.namespace.collectFinalImageProof(root); }
  catch (error) { return { error, calls, slept }; }
  if (phase === 'verdict') advance();
  return { facts, verdict: module.namespace.inspectFinalImageFacts(facts), calls, slept };
}
for (const phase of ['wait', 'stream']) {
  const valid = await run({ phase, expire: false });
  assert.equal(valid.verdict?.machineChecksPassed, true, valid.error?.message); assertions++;
  const expired = await run({ phase });
  assert.match(expired.error?.message ?? '', /expired|timing/i, phase); assertions++;
  if (phase === 'wait') { assert.equal(expired.slept, true); assertions++; }
  // Mutation executes identical real collector with ONLY final clock refresh removed.
  if (phase === 'stream') {
    const stale = await run({ phase, staleMutation: true });
    assert.equal(stale.error, undefined, 'Mutation must demonstrate obsolete collector acceptance');
    assert.ok(stale.facts, 'Obsolete collector returns facts past expiry'); assertions += 2;
  }
}
for (const artifactIndex of [0, 1]) {
  const result = await run({ phase: 'stream', artifactIndex });
  assert.match(result.error?.message ?? '', /artifact expired/i); assertions++;
}
const verdict = await run({ phase: 'verdict' });
assert.equal(verdict.verdict.machineChecksPassed, false); assert.match(verdict.verdict.errors.join(' '), /expired|timing/i); assertions += 2;
const dirty = await run({ phase: 'none', dirty: true });
assert.match(dirty.error?.message ?? '', /Clean exact/); assert.equal(dirty.calls, 4); assertions += 2;
console.log(`${assertions} isolated real-collector clock/layout assertions pass; stale-clock mutation accepts expired facts and corrected collector rejects. No live API, authority or publication.`);
