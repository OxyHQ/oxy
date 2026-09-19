import { writeFile } from 'node:fs/promises';

/**
 * Mark `dist/esm` as ESM.
 *
 * The package root carries NO `"type"`, so Node treats every `.js` as
 * CommonJS by default — which is what makes `dist/types/*.d.ts` usable from a
 * CommonJS consumer under `node16`/`nodenext` resolution. The cost is that the
 * ESM output would be parsed as CommonJS and fail on its own `export` syntax,
 * so this marker restores it for that folder alone.
 *
 * Both markers are required. With only the `cjs` one (the shape this package
 * shipped as 1.0.0, copied from `@oxy.so/telemetry`), the root said
 * `"type": "module"` and a CommonJS consumer's TypeScript refused the types
 * outright: "the referenced file is an ECMAScript module and cannot be imported
 * with require". Mention's backend is CommonJS, so that was every backend
 * consumer.
 */
await writeFile(new URL('../dist/esm/package.json', import.meta.url), '{"type":"module"}\n');
