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
const deployOverridesStart = deploy.indexOf('TASK_ENV_OVERRIDES_JSON: >-');
const deployOverridesEnd = deploy.indexOf('TASK_EXTRA_CONTAINERS_JSON: >-', deployOverridesStart);
const deployOverrides = deploy.slice(deployOverridesStart, deployOverridesEnd);

const failures = [];
if (deployOverridesStart < 0 || deployOverridesEnd < 0) {
  failures.push('the Oxy deploy task-environment block must remain structurally identifiable');
}
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};
const forbid = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

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
  deployOverrides,
  /"INFERENCE_KAANA_EXECUTION":"disabled"/,
  'the candidate readback and canary phase must deploy Oxy with Kaana execution explicitly disabled',
);
forbid(
  deployOverrides,
  /"INFERENCE_KAANA_EXECUTION":"enabled"/,
  'the candidate readback and canary phase must not enable ambient Kaana execution',
);
if ((deployOverrides.match(/"INFERENCE_KAANA_EXECUTION":/g) ?? []).length !== 1) {
  failures.push('the Oxy task environment must contain exactly one Kaana execution binding');
}
requireMatch(
  evidence,
  /readback run: 34301660359[\s\S]*?canary run: 34302325992[\s\S]*?snapshot: snap_da7406fdfed50248[\s\S]*?task definition: arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:359[\s\S]*?image digest: sha256:5be97aa30dfac6b9e0d44d8767ace26017e4ebdb7b5c31da80d80ead7ad76b0b[\s\S]*?provider requests: 2[\s\S]*?Oxy ledger writes: 0/,
  'execution enablement must retain the exact reviewed signed-canary evidence',
);
requireMatch(
  rollout,
  /if \(configured === undefined \|\| configured\.length === 0\) \{\s*return \{ status: 'enabled' \};/,
  'Kaana execution must default on after cutover while retaining the explicit kill switch',
);

if (failures.length > 0) {
  process.stderr.write(`Kaana request-v2 rollout gate failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(
  'Kaana request-v2 producer is exact-ID only; ambient execution is disabled for candidate readback and canary.\n',
);
