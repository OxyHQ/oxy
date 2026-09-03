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

const failures = [];
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
  deploy,
  /"INFERENCE_KAANA_EXECUTION":"disabled"/,
  'the contract-publication deploy must keep Kaana execution explicitly disabled until Kaana dual-version rollout',
);
forbid(
  deploy,
  /"INFERENCE_KAANA_EXECUTION":"enabled"/,
  'this rollout phase must not enable Kaana execution in the same deploy as the v2 producer',
);
requireMatch(
  rollout,
  /if \(configured === undefined \|\| configured\.length === 0\) \{\s*return \{ status: 'disabled', reason: 'not_configured' \};/,
  'an absent Kaana execution switch must remain fail-closed',
);

if (failures.length > 0) {
  process.stderr.write(`Kaana request-v2 rollout gate failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(
  'Kaana request-v2 producer is exact-ID only and held dark by the explicit execution kill switch.\n',
);
