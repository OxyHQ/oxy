import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('checks freshness, regenerates deterministically, and rejects unsafe object keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'oxy-compact-locales-'));
  try {
    const packageRoot = resolve(__dirname, '../../..');
    cpSync(join(packageRoot, 'src/i18n'), join(root, 'src/i18n'), { recursive: true });
    cpSync(
      join(packageRoot, 'scripts/generateCompactLocales.ts'),
      join(root, 'scripts/generateCompactLocales.ts'),
      { recursive: true },
    );
    const script = join(root, 'scripts/generateCompactLocales.ts');
    const run = (...args: string[]) => spawnSync('bun', [script, ...args], { encoding: 'utf8' });
    expect(run('--check').status).toBe(0);
    const generated = join(root, 'src/i18n/locales/compact/fr-FR.generated.ts');
    const original = readFileSync(generated, 'utf8');
    writeFileSync(generated, `${original}\n`);
    expect(run('--check').status).not.toBe(0);
    expect(run().status).toBe(0);
    expect(readFileSync(generated, 'utf8')).toBe(original);
    rmSync(generated);
    expect(run('--check').status).not.toBe(0);
    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);

    const source = join(root, 'src/i18n/locales/fr-FR.ts');
    const sourceOriginal = readFileSync(source, 'utf8');
    writeFileSync(
      source,
      `export default JSON.parse('{"nested":[{"__proto__":{"value":"unsafe"}}]}');\n`,
    );
    const rejected = run();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('Unsupported __proto__ locale key');
    expect(readFileSync(generated, 'utf8')).toBe(original);

    for (const prototype of [`{ inherited: 'value' }`, 'null']) {
      writeFileSync(source, `export default { nested: { '__proto__': ${prototype} } };\n`);
      const rejectedLiteral = run();
      expect(rejectedLiteral.status).not.toBe(0);
      expect(rejectedLiteral.stderr).toContain('Unsupported locale object prototype');
      expect(readFileSync(generated, 'utf8')).toBe(original);
    }

    writeFileSync(
      source,
      `export default { nested: Object.assign(new Array(1), { x: 'extra' }) };\n`,
    );
    const rejectedArray = run();
    expect(rejectedArray.status).not.toBe(0);
    expect(rejectedArray.stderr).toContain('Unsupported sparse or extended locale array');
    expect(readFileSync(generated, 'utf8')).toBe(original);

    writeFileSync(source, sourceOriginal);
    writeFileSync(
      join(root, 'src/i18n/locales/en-US.ts'),
      `export default { nested: { '__proto__': { inherited: 'value' } } };\n`,
    );
    const rejectedEnglish = run();
    expect(rejectedEnglish.status).not.toBe(0);
    expect(rejectedEnglish.stderr).toContain('Unsupported locale object prototype at en-US.ts');
    expect(readFileSync(generated, 'utf8')).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
