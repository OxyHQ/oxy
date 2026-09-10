import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function visit(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) {
      await visit(path);
    } else if (name.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      const updated = source.replace(/(from\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+?)(['"])/g, '$1$2.js$3');
      if (source !== updated) await writeFile(path, updated);
    }
  }
}

await visit(new URL('../dist/esm', import.meta.url).pathname);
