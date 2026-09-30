#!/usr/bin/env bun
/**
 * Fixture tests for scripts/deploy-image-scope.mjs, against the REAL
 * deploy-aws.yml path list. Offline: Bun and builtins only.
 */

import { readFileSync } from 'node:fs';
import { deployPaths, matchingPaths, WORKFLOW_PATH } from './deploy-image-scope.mjs';

const failures = [];
const expect = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const patterns = deployPaths(readFileSync(WORKFLOW_PATH, 'utf8'));

// Changes the deploy ships, so the queue must build.
for (const file of [
  'packages/api/src/server.ts',
  'packages/core/src/index.ts',
  'packages/db/drizzle/0001.sql',
  'Dockerfile',
  'bun.lock',
  'package.json',
  '.github/workflows/deploy-aws.yml',
  '.github/scripts/deploy-ecs-image.sh',
  '.github/scripts/resolve-queue-image.sh',
  '.github/scripts/tag-ecr-image.sh',
]) {
  expect(`builds for ${file}`, matchingPaths([file], patterns), [file]);
}

// Changes it does not, so the queue must not spend a runner on them.
for (const file of [
  'packages/services/src/index.ts',
  'packages/accounts/app/index.tsx',
  'docs/README.md',
  'packages/api-extra/x.ts',
  'packages/api',
  'sub/Dockerfile',
  'sub/package.json',
  '.github/workflows/ci.yml',
]) {
  expect(`skips ${file}`, matchingPaths([file], patterns), []);
}

// The parser refuses shapes it cannot answer for, so the caller builds.
for (const [label, text] of [
  ['no paths', 'on:\n  push:\n    branches: [main]\n'],
  ['negated path', 'on:\n  push:\n    paths: ["!docs/**"]\n'],
]) {
  let threw = false;
  try {
    deployPaths(text);
  } catch {
    threw = true;
  }
  expect(`refuses ${label}`, threw, true);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`deploy-image-scope: all cases pass (${patterns.length} deploy paths)`);
