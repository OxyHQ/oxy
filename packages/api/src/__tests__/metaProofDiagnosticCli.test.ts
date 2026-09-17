import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it.each(['valid', 'foreign-host', 'apply', 'source-url'])('Meta diagnostic CLI accepts only fixed read-only arguments: %s', mode => {
  const directory = mkdtempSync(join(tmpdir(), 'oxy-meta-diagnostic-'));
  const api = resolve(__dirname, '../..');
  const calls = join(directory, 'calls');
  const preload = join(directory, 'preload.ts');
  try {
    writeFileSync(preload, `import { mock } from 'bun:test'; import { writeFileSync } from 'node:fs';
      mock.module(${JSON.stringify(join(api, 'src/services/federation/metaFirstPartyProof.service.ts'))}, () => ({
        inspectMetaFirstPartyProfilePair: async (acct) => { writeFileSync(${JSON.stringify(calls)}, acct);
          return {status:'refused',reason:'upstream_unavailable',policyVersion:'fixture',observations:[]}; }
      }));`);
    const acct = mode === 'foreign-host' ? 'zuck@instagram.com.evil.example' : 'zuck@instagram.com';
    const args = [`--canonical-acct=${acct}`, `--source-sha=${'a'.repeat(40)}`, `--image-digest=sha256:${'b'.repeat(64)}`];
    if (mode === 'apply') args.push('--apply');
    if (mode === 'source-url') args.push('--actor-uri=https://private.example');
    const result = spawnSync('bun', ['--preload', preload, join(api, 'scripts/inspect-meta-profile-proof.ts'), ...args],
      { cwd: api, encoding: 'utf8', timeout: 10000, maxBuffer: 16000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(mode === 'valid' ? 0 : 1);
    if (mode === 'valid') {
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ operation: 'inspect_meta', readOnly: true, canonicalAcct: acct, status: 'refused' });
      expect(report.visited).toBeUndefined();
      expect(report.apply).toBeUndefined();
      expect(readFileSync(calls, 'utf8')).toBe(acct);
    } else {
      expect(existsSync(calls)).toBe(false);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Meta inspection failed');
      expect(result.stderr).not.toContain('private.example');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
