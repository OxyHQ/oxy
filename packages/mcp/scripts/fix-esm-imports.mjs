import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function visit(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) {
      await visit(path);
    } else if (name.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      // Idempotent: `tsc` is incremental here and does not re-emit an unchanged
      // file, so a specifier that already ends in `.js` was fixed by an earlier
      // build and must not become `.js.js`.
      const updated = source.replace(/(from\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+?)(?<!\.js)(['"])/g, '$1$2.js$3');
      if (source !== updated) await writeFile(path, updated);
    }
  }
}

await visit(new URL('../dist/esm', import.meta.url).pathname);
