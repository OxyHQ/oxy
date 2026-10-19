import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// A value import from the root `@oxy.so/contracts` barrel puts all of contracts
// (and its zod) in every app's web bundle; the checks in `/client` are the twins.
describe('contracts entry', () => {
  it('imports runtime values only from @oxy.so/contracts/client', () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      const runtime = readFileSync(file, 'utf8').replace(
        /(?:^|\n)\s*(?:import|export)\s+type\s[^;]+;?/g,
        '\n',
      );
      return /from\s*['"]@oxy\.so\/contracts['"]/.test(runtime);
    });
    expect(offenders.map((file) => file.slice(SRC.length + 1))).toEqual([]);
  });
});
