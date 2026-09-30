/**
 * @jest-environment node
 *
 * `@oxy.so/stickers` must not load `@oxy.so/contracts` at runtime: contracts is
 * zod schemas, and an app that draws one sticker in an empty state should not
 * evaluate zod at startup for it (Mention moved zod off its startup path).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STICKER_RESOLVE_MAX_IDS } from '@oxy.so/contracts';
import { RESOLVE_BATCH_SIZE } from '../client';

const SOURCES = ['client.ts', 'index.ts', 'react.tsx', 'verify.ts'];

it('batches resolves at exactly the API limit contracts declares', () => {
  expect(RESOLVE_BATCH_SIZE).toBe(STICKER_RESOLVE_MAX_IDS);
});

it.each(SOURCES)('%s imports @oxy.so/contracts for types only', (file) => {
  const source = readFileSync(join(__dirname, '..', file), 'utf8');
  // Every import statement naming contracts must be `import type` / `export type`.
  const statements = source.match(/(?:import|export)\s+(type\s+)?\{[^}]*\}\s*from\s*'@oxy\.so\/contracts'/g) ?? [];
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) expect(statement).toMatch(/^(?:import|export)\s+type\s/);
});
