#!/usr/bin/env bun
/**
 * Fail the build when the retired native-product-agent lane comes back.
 *
 * ADR 0042 retired ADR 0025: present-requester assertions, the
 * `/internal/native-agents/*` routes, the reviewed native-agent manifest and its
 * bootstrap, and `@oxy.so/core`'s client and verifier for them. Sindi and
 * Clarity are ordinary Alia agents; a public agent acts for the person present
 * under its owner's ceiling. A second lane for the same situation is exactly
 * what that decision removed, so its vocabulary is not allowed back in source —
 * not as code, not as a comment that still describes it as running.
 *
 * Every tracked file is read. The exceptions are the records that are history
 * by design: the superseded ADR itself, the ADR that retired it, the ADR index,
 * changelogs, and dated evidence directories. A file that has to mention the lane for any other
 * reason is a sign the cut is incomplete, not a reason to widen this list.
 *
 * Run from the repository root. `git ls-files` decides what is tracked, so an
 * untracked scratch file never fails the build and a tracked one always counts.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RETIRED = [
  'nativeRequesterAssertion',
  'NATIVE_PRODUCT_AGENT',
  'nativeProductAgent',
  'native-product-agent',
  'native_product_agent',
  'RequesterAssertion',
  'requester-assertion',
  'Requester-Assertion',
  '/native-agents/',
];

const HISTORY = [
  /^docs\/adr\/0025-/,
  /^docs\/adr\/0042-/,
  // The ADR index, whose rows for 0025 and 0042 summarise exactly those two.
  /^docs\/adr\/README\.md$/,
  /(^|\/)CHANGELOG\.md$/,
  /^docs\/audits\//,
  /^docs\/billing\/evidence\//,
  /^docs\/auth\/1519-strict-service-authority-preflight\//,
  /^scripts\/(test-)?check-retired-native-agent-lane\.mjs$/,
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.length > 0 && !HISTORY.some((pattern) => pattern.test(file)));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // A tracked path deleted in the working tree is not source any more.
    if (error && error.code === 'ENOENT') continue;
    throw error;
  }
  if (text.includes('\0')) continue;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const term = RETIRED.find((candidate) => line.includes(candidate));
    if (term) findings.push(`${file}:${index + 1}: ${term}`);
  });
}

if (findings.length > 0) {
  console.error(
    'The native-product-agent lane is retired (oxy ADR 0042). Remove these references:\n' +
      findings.map((finding) => `  ${finding}`).join('\n'),
  );
  process.exit(1);
}
console.log(`retired native-agent lane: clean across ${files.length} tracked files`);
