import { createRequire } from 'node:module';
import * as contracts from '@oxy.so/contracts';
import * as inference from '@oxy.so/core/inference';

const require = createRequire(import.meta.url);
const { check } = require('./checks.cjs');
// The contracts copy core itself resolves must be the paired release.
const fromCore = createRequire(require.resolve('@oxy.so/core/package.json'));
if (fromCore('@oxy.so/contracts/package.json').version !== '4.8.0') throw new Error('core resolves another contracts version');
await check(contracts, inference, `esm/${typeof Bun === 'undefined' ? 'node' : 'bun'}`);
console.log('decisions release smoke (esm) passed');
