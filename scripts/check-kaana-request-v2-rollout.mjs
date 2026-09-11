#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.KAANA_V2_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

const request = read('packages/contracts/src/inference/request.ts');
const routing = read('packages/contracts/src/inference/routingPolicy.ts');
const edge = read('packages/api/src/services/inferenceEdge.service.ts');
const deploy = read('.github/workflows/deploy-aws.yml');
const rollout = read('packages/api/src/config/rolloutFlags.ts');
const evidence = read('docs/release-evidence/kaana-request-v2-cutover-2026-09-09.md');

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};
const forbid = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

const removalMatches = [
  ...deploy.matchAll(/^ {10}TASK_REMOVE_NAMES_JSON: >-\r?\n {12}(\[[^\r\n]+\])\r?$/gm),
];
let removals = null;
if (removalMatches.length !== 1) {
  failures.push('the Oxy deploy must contain one structurally identifiable task-removal JSON scalar');
} else {
  try {
    removals = JSON.parse(removalMatches[0][1]);
  } catch (error) {
    failures.push(`the Oxy deploy task-removal scalar must be valid JSON: ${String(error)}`);
  }
}
if (!Array.isArray(removals)) {
  failures.push('the Oxy deploy task-removal scalar must be a JSON array');
} else if (removals.filter((name) => name === 'INFERENCE_KAANA_EXECUTION').length !== 1) {
  failures.push('the deploy must remove exactly one inherited Kaana execution rollback binding');
}

const environmentMatches = [
  ...deploy.matchAll(/^ {10}TASK_ENV_OVERRIDES_JSON: >-\r?\n {12}(\{[^\r\n]+\})\r?$/gm),
];
let environmentOverrides = null;
if (environmentMatches.length !== 1) {
  failures.push('the Oxy deploy must contain one structurally identifiable task-environment JSON scalar');
} else {
  try {
    environmentOverrides = JSON.parse(environmentMatches[0][1]);
  } catch (error) {
    failures.push(`the Oxy deploy task-environment scalar must be valid JSON: ${String(error)}`);
  }
}
if (
  environmentOverrides === null ||
  Array.isArray(environmentOverrides) ||
  typeof environmentOverrides !== 'object'
) {
  failures.push('the Oxy deploy task-environment scalar must be a JSON object');
} else if (Object.hasOwn(environmentOverrides, 'INFERENCE_KAANA_EXECUTION')) {
  failures.push('the completed cutover must not retain a Kaana execution environment override');
}

requireMatch(
  request,
  /export const inferenceRequestSchema =[\s\S]*?schemaVersion: z\.literal\(2\)/,
  'the signed inference request must remain explicit wire schemaVersion 2',
);
requireMatch(
  routing,
  /kind: z\.literal\(["']routing_profile_id["']\)[\s\S]*?routingProfileId: routingProfileIdSchema/,
  'the canonical routing target must carry an exact opaque routing-profile PK',
);
const targetBlock = routing.slice(
  routing.indexOf('export const routingTargetSchema'),
  routing.indexOf('export const routingPolicyScopeSchema'),
);
forbid(
  targetBlock,
  /kind: z\.literal\(["']routing_profile["']\)|routingProfile: routingProfileSlugSchema/,
  'the signed routing target must not retain a slug arm',
);
requireMatch(
  edge,
  /admittedRoutingTarget = \{[\s\S]*?kind: 'routing_profile_id',[\s\S]*?routingProfileId: profile\.routingProfileId/,
  'Oxy must normalize both public selectors to a routing-profile PK before the envelope',
);
requireMatch(
  edge,
  /schemaVersion: 2,[\s\S]*?attribution:/,
  'Oxy buildEnvelope must emit inference request schemaVersion 2',
);
requireMatch(
  evidence,
  /readback run: 34301660359[\s\S]*?canary run: 34302325992[\s\S]*?snapshot: snap_da7406fdfed50248[\s\S]*?task definition: arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:359[\s\S]*?image digest: sha256:5be97aa30dfac6b9e0d44d8767ace26017e4ebdb7b5c31da80d80ead7ad76b0b[\s\S]*?provider requests: 2[\s\S]*?Oxy ledger writes: 0/,
  'execution enablement must retain the exact reviewed signed-canary evidence',
);
forbid(
  rollout,
  /INFERENCE_KAANA_EXECUTION|KaanaExecution|kaanaExecution/,
  'canonical Kaana execution must not regain an independent runtime switch',
);

if (failures.length > 0) {
  process.stderr.write(`Kaana request-v2 rollout gate failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(
  'Kaana request-v2 producer is exact-ID only and enabled after the recorded signed canary.\n',
);
