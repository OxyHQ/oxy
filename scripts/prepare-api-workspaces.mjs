/** Stage the published validator artifacts that the API and data-node images run. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './check-zod-forks.mjs';

export function prepareRuntimeValidators(root, destination, names = ['zod3', 'zod4']) {
  assert.ok(names.length > 0 && names.every((name) => ['zod3', 'zod4'].includes(name)));
  const temporary = mkdtempSync(join(tmpdir(), 'oxy-runtime-validators-'));
  try {
    for (const name of names) {
      const archive = join(temporary, `${name}.tgz`);
      // Packing uses the package's actual publish file list. It excludes local
      // compiler dependencies and stale non-published build directories.
      execFileSync('bun', ['pm', 'pack', '--filename', archive, '--quiet'], {
        cwd: join(root, 'packages', name),
        stdio: 'inherit',
        timeout: 60_000,
      });
      const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
        .trim()
        .split('\n');
      assert.ok(
        entries.every((entry) => entry.startsWith('package/') && !entry.split('/').includes('..')),
      );
      const directory = join(destination, name);
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory, { recursive: true });
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', directory]);
      assert.ok(
        !existsSync(join(directory, 'node_modules')),
        'Published validators must not ship build dependencies',
      );
      verifyPackage(directory);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(
    process.argv[2],
    'Usage: node scripts/prepare-api-workspaces.mjs destination [zod3 zod4]',
  );
  prepareRuntimeValidators(
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    resolve(process.argv[2]),
    process.argv.length > 3 ? process.argv.slice(3) : undefined,
  );
}
