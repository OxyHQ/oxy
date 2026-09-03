#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflowPath = join('.github', 'workflows', 'cloudflare-dns-kaana.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const problems = [];

function requireExact(fragment, message) {
  const matches = workflow.split(fragment).length - 1;
  if (matches !== 1) problems.push(`${message} (found ${matches}, expected exactly 1)`);
}

requireExact(
  'wanted.append((os.environ["VAL_NAME"].rstrip("."),\n                             os.environ["VAL_VALUE"].rstrip("."), False))',
  'the ACM validation CNAME must stay DNS-only',
);
requireExact(
  'wanted.append(("kaana.ai", os.environ["ALB_DNS"].rstrip("."), False))',
  'the kaana.ai apex must stay DNS-only and point only at the supplied dedicated ALB',
);
requireExact('ZONE_NAME = "kaana.ai"', 'the workflow must edit only the canonical kaana.ai zone');

for (const retired of ['kaana.oxy.so', 'api.kaana.ai', 'oxy-alb-']) {
  if (workflow.includes(retired)) problems.push(`retired/shared DNS identity ${retired} returned to the Kaana DNS workflow`);
}

if (problems.length) {
  console.error('Kaana DNS boundary is BROKEN:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log('Kaana DNS boundary is exact: validation and kaana.ai are DNS-only and the apex points to the dedicated ALB.');
