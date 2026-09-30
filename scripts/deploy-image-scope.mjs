#!/usr/bin/env bun
/**
 * Would `Deploy to AWS` run for this commit? Asked by the merge-queue image
 * job (.github/workflows/merge-queue-image.yml) before it builds anything.
 *
 * The queue builds the production image so that the push-to-main deploy can
 * reuse it instead of rebuilding. That only pays when the deploy runs at all,
 * and it runs only when the push touches one of `on.push.paths` in
 * deploy-aws.yml. This reads that list back from the workflow itself — never a
 * copy of it — and matches the files the queue entry changes against it with
 * GitHub's glob rules (`*` stops at `/`, `**` does not).
 *
 * Either wrong answer is safe, which is why this is allowed to be simple: a
 * false `false` means the deploy finds no queue image and builds it itself, as
 * it always did; a false `true` means one unused image that the ECR lifecycle
 * rule for `mq-*` expires after three days.
 *
 * Usage: deploy-image-scope.mjs <base sha> <head sha>
 * Prints the decision and the paths that decided it; writes `build=true|false`
 * to $GITHUB_OUTPUT when set. Anything it cannot read fails toward `true`.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

export const WORKFLOW_PATH = '.github/workflows/deploy-aws.yml';

export function deployPaths(workflowText) {
  const workflow = Bun.YAML.parse(workflowText);
  // YAML 1.1 folds a bare `on` key to boolean true; Bun.YAML keeps the string.
  const on = workflow?.on ?? workflow?.[true];
  const paths = on?.push?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
    throw new Error(`${WORKFLOW_PATH} has no on.push.paths list`);
  }
  if (paths.some((p) => p.startsWith('!'))) {
    throw new Error(`${WORKFLOW_PATH} uses a negated path; this scope does not implement negation`);
  }
  return paths;
}

export function matchingPaths(changed, patterns) {
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  return changed.filter((file) => globs.some((glob) => glob.match(file)));
}

function decide(base, head) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '')) {
    return { build: true, reason: 'no usable base/head SHA pair' };
  }
  let patterns;
  let changed;
  try {
    patterns = deployPaths(readFileSync(WORKFLOW_PATH, 'utf8'));
    changed = execFileSync('git', ['diff', '--name-only', `${base}..${head}`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    return { build: true, reason: `could not decide (${error.message}), building anyway` };
  }
  const hits = matchingPaths(changed, patterns);
  return hits.length > 0
    ? { build: true, reason: `deploy-aws.yml deploys this change: ${hits.slice(0, 10).join(', ')}` }
    : { build: false, reason: `none of ${changed.length} changed path(s) is in deploy-aws.yml on.push.paths` };
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  const { build, reason } = decide(base, head);
  console.log(`build=${build}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
}
