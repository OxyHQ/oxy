import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it.each(['valid', 'duplicate', 'apply', 'source-url'])('Profile diagnostic CLI accepts only fixed read-only arguments: %s', mode => {
  const directory = mkdtempSync(join(tmpdir(), 'oxy-profile-diagnostic-'));
  const api = resolve(__dirname, '../..');
  const calls = join(directory, 'calls');
  const preload = join(directory, 'preload.ts');
  try {
    writeFileSync(preload, `import { mock } from 'bun:test'; import { writeFileSync } from 'node:fs';
      mock.module(${JSON.stringify(join(api, 'src/config/postgres.ts'))}, () => ({connectPostgres:async()=>{},closePostgres:async()=>{}}));
      mock.module(${JSON.stringify(join(api, 'src/config/redis.ts'))}, () => ({closeRedis:async()=>{}}));
      mock.module(${JSON.stringify(join(api, 'src/services/externalProfileInspection.service.ts'))}, () => ({
        validateProfileInspectionInput: () => {}, inspectExternalProfile: async (input) => { writeFileSync(${JSON.stringify(calls)}, input.actorUri);
          return {operation:'inspect_profile',readOnly:true,actorUri:input.actorUri,before:{},after:{},failure:{reason:'signing_key_unavailable'}}; }
      }));`);
    const acct = 'https://bird.makeup/users/example';
    const args = [`--actor-uri=${acct}`, `--source-sha=${'a'.repeat(40)}`, `--image-digest=sha256:${'b'.repeat(64)}`];
    if (mode === 'duplicate') args.push(`--actor-uri=${acct}`);
    if (mode === 'apply') args.push('--apply');
    if (mode === 'source-url') args.push('--canonical-acct=private@example.com');
    const result = spawnSync('bun', ['--preload', preload, join(api, 'scripts/inspect-external-profile.ts'), ...args],
      { cwd: api, encoding: 'utf8', timeout: 10000, maxBuffer: 16000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(mode === 'valid' ? 0 : 1);
    if (mode === 'valid') {
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ operation: 'inspect_profile', readOnly: true, actorUri: acct });
      expect(report.visited).toBeUndefined();
      expect(report.apply).toBeUndefined();
      expect(readFileSync(calls, 'utf8')).toBe(acct);
    } else {
      expect(existsSync(calls)).toBe(false);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Profile inspection failed');
      expect(result.stderr).not.toContain('private.example');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
