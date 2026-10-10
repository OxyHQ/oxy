/**
 * `expo-clipboard` is an OPTIONAL peer, named by exactly one file: the native
 * fork of `ui/utils/clipboard`. The default fork, which `tsc`, Vite and SSR
 * resolve, names nothing, so a consumer typechecking without `.native`
 * suffixes never meets the specifier (package-rules.md#package-boundaries),
 * and a web bundle never tries to resolve it. React Native's deprecated
 * `Clipboard` is used nowhere.
 */
import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Code only: comments may explain the rule without breaking it. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('clipboard boundary', () => {
  const files = sourceFiles(srcRoot);

  it('walks the real source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('names expo-clipboard only in the native fork', () => {
    const naming = files
      .filter((file) => /['"]expo-clipboard['"]/.test(code(file)))
      .map((file) => path.relative(srcRoot, file));
    expect(naming).toEqual([path.join('ui', 'utils', 'clipboard.native.ts')]);
  });

  it('keeps the default fork free of it', () => {
    expect(code(path.join(srcRoot, 'ui/utils/clipboard.ts'))).not.toMatch(/expo-clipboard/);
  });

  it("never uses React Native's deprecated Clipboard", () => {
    const offenders = files
      .filter((file) =>
        /import\s*\{[^}]*\bClipboard\b[^}]*\}\s*from\s*['"]react-native['"]/.test(code(file)),
      )
      .map((file) => path.relative(srcRoot, file));
    expect(offenders).toEqual([]);
  });
});
