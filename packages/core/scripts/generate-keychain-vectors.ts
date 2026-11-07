/**
 * Writes src/crypto/keychain/__tests__/vectors.json from the fixed inputs in
 * vectorGenerator.ts (ADR 0063 D8). Run from packages/core:
 *   bun scripts/generate-keychain-vectors.ts
 * `vectors.test.ts` fails when the committed file differs from what this writes.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVectors } from '../src/crypto/keychain/__tests__/vectorGenerator';

const target = join(import.meta.dir, '../src/crypto/keychain/__tests__/vectors.json');
writeFileSync(target, `${JSON.stringify(buildVectors(), null, 2)}\n`);
console.log(`wrote ${target}`);
