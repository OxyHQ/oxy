import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const root = process.cwd();
const files = [
  '.github/workflows/reconcile-external-identities.yml',
  '.github/scripts/run-external-identity-reconciliation.sh',
  '.github/workflows/ci.yml',
];
const scratch = mkdtempSync(join(tmpdir(), 'external-identity-operations-'));
try {
  for (const file of files) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    cpSync(join(root, file), join(scratch, file));
  }
  const run = () =>
    spawnSync(process.execPath, [join(root, 'scripts/check-external-identity-operations.mjs')], {
      env: { ...process.env, EXTERNAL_IDENTITY_OPERATIONS_ROOT: scratch },
      encoding: 'utf8',
    });
  assert.equal(run().status, 0, run().stderr);
  for (const [file, before] of [
    [files[0], "if: github.ref == 'refs/heads/main'"],
    [files[0], 'expected_source_sha:'],
    [files[1], 'deregister-task-definition'],
    [files[1], 'GITHUB_REF_PROTECTED'],
    [files[1], 'batch-get-image'],
    [files[1], '5400'],
    [files[2], 'node scripts/check-external-identity-operations.mjs'],
  ]) {
    const path = join(scratch, file);
    const text = readFileSync(path, 'utf8');
    assert.ok(text.includes(before));
    writeFileSync(path, text.replaceAll(before, 'removed-invariant'));
    assert.equal(run().status, 1, `Gate accepted missing ${before}`);
    writeFileSync(path, text);
  }
  console.log(
    'External identity operations guard: clean fixture and seven unsafe mutations checked',
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
