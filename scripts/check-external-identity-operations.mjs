import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.EXTERNAL_IDENTITY_OPERATIONS_ROOT || process.cwd();
const failures = [];
function requireText(path, fragments) {
  let source;
  try {
    source = readFileSync(join(root, path), 'utf8');
  } catch {
    failures.push(`${path}: missing`);
    return;
  }
  for (const fragment of fragments)
    if (!source.includes(fragment)) failures.push(`${path}: missing invariant ${fragment}`);
}
requireText('.github/workflows/reconcile-external-identities.yml', [
  "if: github.ref == 'refs/heads/main' && github.ref_protected",
  'default: true',
  'expected_source_sha:',
  'cancel-in-progress: false',
  '.github/scripts/run-external-identity-reconciliation.sh',
]);
requireText('.github/scripts/run-external-identity-reconciliation.sh', [
  'packages/api/scripts/reconcile-external-identities.ts',
  'stop-task',
  'deregister-task-definition',
  'imageDigest',
  'get-log-events',
  'EXPECTED_SOURCE_SHA',
  'DRY_RUN',
  'GITHUB_REF_PROTECTED',
  'GITHUB_SHA',
  'batch-get-image',
  'busybox',
  'timeout',
  '5400',
]);
requireText('.github/workflows/ci.yml', [
  'bash .github/scripts/test-run-external-identity-reconciliation.sh',
  'node scripts/test-check-external-identity-operations.mjs',
  'node scripts/check-external-identity-operations.mjs',
]);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('External identity operations guard passed');
