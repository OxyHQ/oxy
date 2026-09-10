import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const assetsDir = new URL('../dist/assets/', import.meta.url);
const entryFiles = readdirSync(assetsDir).filter((name) => /^index-[^.]+\.js$/.test(name));

if (entryFiles.length !== 1) {
  throw new Error(`Expected one Vite entry chunk, found ${entryFiles.length}: ${entryFiles.join(', ')}`);
}

const entryPath = join(assetsDir.pathname, entryFiles[0]);
const source = readFileSync(entryPath);
const sizes = { raw: source.byteLength, gzip: gzipSync(source, { level: 9 }).byteLength };
const budget = {
  // Baseline after screen-barrel isolation (2026-09-08):
  // 8,902,470 raw / 2,047,700 gzip. The small margin absorbs deterministic
  // dependency patch drift without permitting another screen graph in entry.
  raw: 9_000_000,
  gzip: 2_100_000,
};

for (const format of ['raw', 'gzip']) {
  if (sizes[format] > budget[format]) {
    throw new Error(
      `Initial JS ${format} size ${sizes[format].toLocaleString()} exceeds `
      + `${budget[format].toLocaleString()} byte budget`,
    );
  }
}

console.log(
  `[bundle-budget] ok — initial JS ${sizes.raw.toLocaleString()} raw / `
  + `${sizes.gzip.toLocaleString()} gzip`,
);
