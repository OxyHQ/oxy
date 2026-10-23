#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectZodLock } from './zod-audit-paths.mjs';
const source = Bun.JSONC.parse(readFileSync(new URL('../bun.lock', import.meta.url), 'utf8'));
assert.deepEqual(inspectZodLock(source).errors, [], 'committed lock must match reviewed paths');
const cases = [
  [
    'own API vulnerable parser',
    (lock) => {
      lock.packages['@oxy.so/api/zod'] = ['zod@3.25.76', '', {}];
    },
  ],
  [
    'published core vulnerable parser',
    (lock) => {
      lock.packages['@oxy.so/core/zod'] = ['zod@3.25.76', '', {}];
    },
  ],
  [
    'another old v3 version',
    (lock) => {
      lock.packages['@atproto/oauth-types/zod'][0] = 'zod@3.24.1';
    },
  ],
  [
    'vulnerable v4',
    (lock) => {
      lock.packages.zod[0] = 'zod@4.4.3';
    },
  ],
  [
    'atproto version drift',
    (lock) => {
      lock.packages['@atproto/oauth-client'][0] = '@atproto/oauth-client@0.8.8';
    },
  ],
  [
    'another runtime consuming atproto',
    (lock) => {
      lock.workspaces['packages/core'].dependencies['@atproto/oauth-client-node'] = '0.5.7';
    },
  ],
  [
    'new API parser bypass',
    (lock) => {
      lock.workspaces['packages/api'].dependencies['@atproto/oauth-types'] = '0.7.6';
    },
  ],
  [
    'public SDK receives API transitively',
    (lock) => {
      lock.workspaces['packages/core'].dependencies['@oxy.so/api'] = 'workspace:*';
    },
  ],
  [
    'shadcn becomes runtime',
    (lock) => {
      lock.workspaces['packages/test-app-vite'].dependencies.shadcn = 'catalog:';
      delete lock.workspaces['packages/test-app-vite'].devDependencies.shadcn;
    },
  ],
  [
    'shadcn version drift',
    (lock) => {
      lock.packages.shadcn[0] = 'shadcn@3.8.6';
    },
  ],
  [
    'Expo vendored artifact changes',
    (lock) => {
      lock.packages['@expo/cli'][2] = 'sha512-unreviewed';
    },
  ],
  [
    'API directly consumes Expo CLI',
    (lock) => {
      lock.workspaces['packages/api'].dependencies['@expo/cli'] = '^58.1.11';
    },
  ],
  [
    'published SDK directly consumes Expo CLI',
    (lock) => {
      lock.workspaces['packages/core'].dependencies['@expo/cli'] = '^58.1.11';
    },
  ],
  [
    'new transitive runtime consumes Expo CLI',
    (lock) => {
      lock.workspaces['packages/api'].dependencies['new-runtime'] = '1.0.0';
      lock.packages['new-runtime'] = [
        'new-runtime@1.0.0',
        '',
        { dependencies: { '@expo/cli': '^58.1.11' } },
      ];
    },
  ],
  [
    'unknown vulnerable leaf',
    (lock) => {
      lock.packages['new-parser/zod'] = ['zod@3.25.76', '', {}];
    },
  ],
];
for (const [label, mutate] of cases) {
  const lock = structuredClone(source);
  mutate(lock);
  assert.ok(inspectZodLock(lock).errors.length > 0, `must reject ${label}`);
  console.log(`ok ${label}`);
}
const patched = structuredClone(source);
for (const entry of Object.values(patched.packages))
  if (entry[0].startsWith('zod@')) entry[0] = 'zod@4.6.7';
assert.equal(
  inspectZodLock(patched).residuals.length,
  0,
  'fully patched graph retires acknowledgement',
);
console.log(`Zod lock path guard: ${cases.length + 2} cases passed.`);
