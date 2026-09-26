/**
 * `scripts/fix-esm-imports.mjs` must rewrite DYNAMIC relative imports too.
 *
 * ## The failure this exists for, which happened
 *
 * This package writes relative specifiers without an extension — legal under
 * `moduleResolution: bundler`, illegal in Node's ESM resolver — and the
 * post-build script adds the extension back. For its first life the script's
 * pattern was `(?:from|import)\s+['"]`, which cannot match `import('./x')`:
 * the keyword is followed by a parenthesis, not whitespace. Every dynamic
 * import therefore shipped extensionless in `dist/esm`.
 *
 * `OxyServer.serviceToken()` loads `../server/workloadIdentity` that way
 * to decide whether this process can attest its workload identity (ADR 0026),
 * and it does so inside a `try/catch` that reads any failure as "cannot attest
 * here". So in every ESM consumer of the BUILT package the ADR 0026 fallback
 * was dead, and a service whose task role attests perfectly well was told
 * `Service credentials not provided` — which is what a deployment sees the
 * moment its key pair is removed, and the reason `mention-mcp` and `alia` could
 * not complete the migration while `mention`, `allo` and `alia-integrations`
 * (all CommonJS, where `require()` supplies the extension) already had.
 *
 * ## Why this spawns the real script
 *
 * The defect is in the build OUTPUT, and core's CI job runs jest without
 * building the package, so a test that reads `dist/esm` would pass by finding
 * nothing. `serviceTokenWorkloadFallback.test.ts` cannot catch it either: jest
 * resolves extensionless specifiers, and it mocks that module by name. The one
 * thing that measures the real behaviour without a build is to run the script
 * over a fixture and read what it wrote.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.resolve(__dirname, '../../scripts/fix-esm-imports.mjs');

function runOnFixture(files: Record<string, string>): Record<string, string> {
  const root = mkdtempSync(path.join(tmpdir(), 'oxy-core-esm-fix-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, source);
    }
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const out: Record<string, string> = {};
    for (const name of Object.keys(files)) {
      out[name] = readFileSync(path.join(root, name), 'utf8');
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('fix-esm-imports', () => {
  it('adds .js to a dynamic relative import', () => {
    const out = runOnFixture({
      'server/workloadIdentity.js': 'export const canAttestWorkloadIdentity = () => true;\n',
      'api/auth.js': [
        'export async function canUse() {',
        "  const { canAttestWorkloadIdentity } = await import('../server/workloadIdentity');",
        '  return canAttestWorkloadIdentity();',
        '}',
        '',
      ].join('\n'),
    });

    expect(out['api/auth.js']).toContain("await import('../server/workloadIdentity.js')");
  });

  it('rewrites every dynamic import in a file, not only the first', () => {
    const out = runOnFixture({
      'server/workloadIdentity.js': 'export const a = 1;\nexport const b = 2;\n',
      'api/auth.js': [
        "const first = await import('../server/workloadIdentity');",
        "const second = await import('../server/workloadIdentity');",
        '',
      ].join('\n'),
    });

    const matches = out['api/auth.js'].match(/workloadIdentity\.js/g) ?? [];
    expect(matches).toHaveLength(2);
    // And nothing was left extensionless.
    expect(out['api/auth.js']).not.toMatch(/workloadIdentity'/);
  });

  it('tolerates whitespace between the keyword and the parenthesis', () => {
    const out = runOnFixture({
      'server/workloadIdentity.js': 'export const a = 1;\n',
      'api/auth.js': "const m = await import(\n  '../server/workloadIdentity'\n);\n",
    });

    expect(out['api/auth.js']).toContain("'../server/workloadIdentity.js'");
  });

  it('resolves a dynamic directory import to its index', () => {
    const out = runOnFixture({
      'server/index.js': 'export const a = 1;\n',
      'api/auth.js': "const m = await import('../server');\n",
    });

    expect(out['api/auth.js']).toContain("'../server/index.js'");
  });

  it('still rewrites the static forms, and leaves bare and already-suffixed specifiers alone', () => {
    const out = runOnFixture({
      'server/workloadIdentity.js': 'export const a = 1;\n',
      'api/auth.js': [
        "import { a } from '../server/workloadIdentity';",
        "import '../server/workloadIdentity';",
        "export { a as b } from '../server/workloadIdentity';",
        "import { createHash } from 'node:crypto';",
        "import { z } from 'zod';",
        "const late = await import('./sibling.js');",
        '',
      ].join('\n'),
      'api/sibling.js': 'export const s = 1;\n',
    });

    const source = out['api/auth.js'];
    expect(source.match(/workloadIdentity\.js/g) ?? []).toHaveLength(3);
    expect(source).toContain("import { createHash } from 'node:crypto';");
    expect(source).toContain("import { z } from 'zod';");
    expect(source).toContain("await import('./sibling.js')");
    expect(source).not.toContain('sibling.js.js');
  });
});
