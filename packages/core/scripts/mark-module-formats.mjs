import { mkdir, writeFile } from 'node:fs/promises';

for (const [directory, type] of [
  ['dist/cjs', 'commonjs'],
  ['dist/esm', 'module'],
]) {
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/package.json`, `${JSON.stringify({ type }, null, 2)}\n`);
}
