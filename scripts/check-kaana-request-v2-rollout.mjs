#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.KAANA_V2_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

const request = read('packages/contracts/src/inference/request.ts');
const routing = read('packages/contracts/src/inference/routingPolicy.ts');
const edge = read('packages/api/src/services/inferenceEdge.service.ts');
const evidence = read('docs/release-evidence/kaana-request-v2-cutover-2026-09-09.md');

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
  /admittedRoutingTarget = \{[\s\S]*?kind: 'routing_profile_id',[\s\S]*?routingProfileId: (?:profile\.routingProfileId|resolvedProfileId)/,
  'Oxy must normalize both public selectors to a routing-profile PK before the envelope',
);
// Check the producer expression itself, rather than allowing another version
// mentioned elsewhere in the file to satisfy the ordinary-envelope guard.
const envelopeStart = edge.indexOf('export function buildEnvelope(');
const envelope = edge.slice(envelopeStart, edge.indexOf('attribution:', envelopeStart))
  .replace(/\s+/g, ' ');
if (edge.includes('privateAutoInferenceRequestSchema')) {
  requireMatch(envelope,
    /return \(admitted\.privateAutoExecution !== undefined \? privateAutoInferenceRequestSchema : admitted\.scopedExecution === undefined \? inferenceRequestSchema : scopedInferenceRequestSchema\)\.parse\(\{ schemaVersion: admitted\.privateAutoExecution !== undefined \? 4 : admitted\.scopedExecution === undefined \? 2 : 3, \.\.\.\(admitted\.privateAutoExecution === undefined \? \{\} : \{ privateAutoExecution: admitted\.privateAutoExecution \}\), \.\.\.\(admitted\.scopedExecution === undefined \? \{\} : \{ scopedExecution: admitted\.scopedExecution \}\), $/,
    'private v4 and v3 must use their exact admitted authority and strict schemas; ordinary requests remain v2');
  const auto = read('packages/contracts/src/inference/privateAutoExecution.ts');
  const scoped = read('packages/contracts/src/inference/scopedExecution.ts');
  requireMatch(auto, /export const PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION = "3\.7\.0" as const;/,
    'private Auto must retain the independently negotiated 3.7 contract');
  requireMatch(auto, /export const PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION = 4 as const;/,
    'private Auto must retain explicit wire schemaVersion 4');
  requireMatch(scoped, /export const SCOPED_REQUEST_ENVELOPE_VERSION = 3 as const;/,
    'the scoped contract must retain explicit wire schemaVersion 3');
  requireMatch(request,
    /export const privateAutoInferenceRequestSchema = inferenceRequestSchema\.innerType\(\)\s*\.omit\(\{ scopedExecution: true \}\)\s*\.extend\(\{ schemaVersion: z\.literal\(PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION\), privateAutoExecution: privateAutoExecutionSchema \}\)\s*\.strict\(\)/,
    'private v4 must reject mixed scoped authority and use its exact strict contract');
  requireMatch(request,
    /export const scopedInferenceRequestSchema = inferenceRequestSchema\.innerType\(\)\s*\.extend\(\{ schemaVersion: z\.literal\(SCOPED_REQUEST_ENVELOPE_VERSION\), scopedExecution: scopedExecutionSchema \}\)/,
    'private v3 must retain its exact scoped contract');
  requireMatch(edge,
    /completion = await context\.kaanaClient\.execute\(envelope, \{\s*signal: context\.signal,\s*\.\.\.\(admitted\.privateAutoExecution === undefined \? \{\} : \{\s*privateAutoExecutionContractVersion: '3\.7\.0' as const,\s*\}\),\s*\}\)/,
    'private v4 dispatch must negotiate 3.7 only for its admitted private authority');
} else if (edge.includes('scopedInferenceRequestSchema')) {
  requireMatch(envelope,
    /return \(admitted\.scopedExecution === undefined \? inferenceRequestSchema : scopedInferenceRequestSchema\)\.parse\(\{ schemaVersion: admitted\.scopedExecution === undefined \? 2 : 3, \.\.\.\(admitted\.scopedExecution === undefined \? \{\} : \{ scopedExecution: admitted\.scopedExecution \}\), $/,
    'private v3 must be bound to the admitted scoped audience and its strict schema; ordinary requests remain v2');
} else {
  requireMatch(envelope, /return inferenceRequestSchema\.parse\(\{ schemaVersion: 2, $/,
    'Oxy buildEnvelope must emit inference request schemaVersion 2');
}
requireMatch(
  evidence,
  /readback run: 34301660359[\s\S]*?canary run: 34302325992[\s\S]*?snapshot: snap_da7406fdfed50248[\s\S]*?task definition: arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:359[\s\S]*?image digest: sha256:5be97aa30dfac6b9e0d44d8767ace26017e4ebdb7b5c31da80d80ead7ad76b0b[\s\S]*?provider requests: 2[\s\S]*?Oxy ledger writes: 0/,
  'execution enablement must retain the exact reviewed signed-canary evidence',
);

if (failures.length > 0) {
  process.stderr.write(`Kaana request-v2 rollout gate failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(
  'Kaana request-v2 producer is exact-ID only and enabled after the recorded signed canary.\n',
);
