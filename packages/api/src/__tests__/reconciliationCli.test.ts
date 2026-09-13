import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Exercise the real CLI entry point, including its process lifetime and pipe flush. */
describe('external identity reconciliation command lifecycle', () => {
  test.each([false, true])('closes both resources and exits with a full report (cleanup failure: %s)', (failCleanup) => {
    const scratch = mkdtempSync(join(tmpdir(), 'oxy-reconciliation-cli-'));
    const apiRoot = resolve(__dirname, '../..');
    const modulePath = (path: string) => JSON.stringify(join(apiRoot, path));
    try {
      const preload = join(scratch, 'preload.ts');
      writeFileSync(preload, `
        import { mock } from 'bun:test';
        let pages = 0;
        const query = { from() { return this; }, where() { return this; }, orderBy() { return this; }, limit() {
          return Promise.resolve(pages++ === 0 ? [{actorUri:'https://bird.makeup/users/test', canonicalAcct:'test@bird.makeup'}] : []);
        }};
        mock.module(${modulePath('src/config/postgres.ts')}, () => ({
          connectPostgres: async () => {}, getDb: () => ({select: () => query}),
          closePostgres: async () => { await Bun.sleep(10); console.log('POSTGRES_CLOSED'); ${failCleanup ? "throw new Error('private cleanup detail');" : ''} }
        }));
        mock.module(${modulePath('src/config/redis.ts')}, () => ({closeRedis: async () => {
          await Bun.sleep(10); console.log('REDIS_CLOSED');
        }}));
        mock.module(${modulePath('src/services/federation.service.ts')}, () => ({federationService: {
          fetchActorProfileResult: async () => ({ok:false,failure:{reason:'http_status',phase:'actor_fetch',httpStatus:404}})
        }}));
        mock.module(${modulePath('src/services/federation/metaIdentityProofRegistry.service.ts')}, () => ({revokeMetaIdentityProof: async () => {}}));
        mock.module(${modulePath('src/db/schema/externalIdentities.ts')}, () => ({externalIdentityActors:{}}));
        mock.module(${modulePath('src/db/schema/users.ts')}, () => ({users:{}}));
        // Server imports can own persistent handles; CLI completion must bound them.
        setInterval(() => {}, 1000);
        process.stdout.write('x'.repeat(300000) + '\\n');
      `);
      const result = spawnSync('bun', ['--preload', preload, join(apiRoot, 'scripts/reconcile-external-identities.ts'), '--apply'], {
        cwd: apiRoot, env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
        encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failCleanup ? 1 : 2);
      expect(result.stdout).toContain('x'.repeat(300000));
      expect(result.stdout).toContain('POSTGRES_CLOSED\nREDIS_CLOSED');
      expect(result.stdout).toContain('"visited":1,"changed":0,"refused":1,"pending":0');
      expect(result.stderr).not.toContain('private cleanup detail');
      if (failCleanup) expect(result.stderr).toContain('Reconciliation failed');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 20000);
});
