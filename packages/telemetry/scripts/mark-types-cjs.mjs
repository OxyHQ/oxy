import { writeFile } from 'node:fs/promises';

// The one `dist/types` serves BOTH the `import` and the `require` condition. Under
// this package's `"type": "module"` TypeScript would read those `.d.ts` files as
// ESM, and a CommonJS consumer resolving with `node16`/`nodenext` (Mention's
// backend) is then refused with TS1479. Read as CommonJS they serve both, which is
// what every sibling package without a `type` field already does.
await writeFile(new URL('../dist/types/package.json', import.meta.url), '{"type":"commonjs"}\n');
