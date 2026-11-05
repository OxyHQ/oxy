/** Actual compiled Node entrypoint: obsolete provisioning refuses before database/network access. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const executable = path.join(root, 'packages/api/dist/scripts/foregroundPilotExecutor.js');
for (const operation of ['execute', 'rollback']) {
  const result = spawnSync(process.execPath, [executable, operation, 'e30'], {
    env: { NODE_ENV: 'test', OXY_API_URL: 'https://api.oxy.so' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'I05_FOREGROUND_OPERATION_FAILED_RECONCILE_REQUIRED');
  assert.equal(result.stdout, '');
}
console.log(
  JSON.stringify({
    kind: 'i05-compiled-retirement-refusal',
    checks: 2,
    databaseConfigured: false,
    externalHttpRequests: 0,
  }),
);
