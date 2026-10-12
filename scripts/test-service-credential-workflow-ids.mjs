#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const canonicalKaanaApplicationId = '68b7c4e19f2a6d0e3c8b5174';
const canonicalHomiioApplicationId = '6a2f851751b784a86fd0e922';
const canonicalInboxApplicationId = '6a37b3e61ddfd195b656819b';
const canonicalInboxCredentialId = '01a06134-022c-72b6-a876-27da37a39e39';
const canonicalAliaApplicationId = '6a2f851751b784a86fd0e934';
const canonicalMentionApplicationId = '6a2f851751b784a86fd0e916';

const provision = readFileSync('.github/workflows/provision-service-credential.yml', 'utf8');
const reconcile = readFileSync(
  '.github/workflows/reconcile-service-credential-authority.yml',
  'utf8',
);
const reconcileScript = readFileSync(
  'packages/api/scripts/reconcile-service-credential-authority.ts',
  'utf8',
);
const provisionScript = readFileSync('packages/api/scripts/create-service-credential.ts', 'utf8');
const finalizeScript = readFileSync('packages/api/scripts/finalize-service-credential.ts', 'utf8');
const secureParameterScript = readFileSync('.github/scripts/put-secure-parameter.sh', 'utf8');
const scopeRotationRegistry = readFileSync(
  'packages/api/src/utils/serviceCredentialScopeRotations.ts',
  'utf8',
);
const handoffScript = readFileSync('.github/scripts/handoff-service-credential-pair.sh', 'utf8');

function registryArm(workflow, applicationId) {
  const match = workflow.match(new RegExp(`\\n\\s+${applicationId}\\)\\n([\\s\\S]*?)\\n\\s+;;`));
  assert.ok(match, `missing exact registry arm for ${applicationId}`);
  return match[1];
}

for (const [name, workflow] of [
  ['provision', provision],
  ['reconcile', reconcile],
]) {
  assert.match(
    workflow,
    new RegExp(canonicalKaanaApplicationId),
    `${name} must bind the exact Kaana app id`,
  );
  assert.match(workflow, /inference:byok:validate/, `${name} must carry Kaana validation`);
  assert.match(
    workflow,
    /CREDENTIAL_ENVIRONMENT="production"|CREDENTIAL_ENVIRONMENT: production/,
    `${name} must bind production explicitly`,
  );
  assert.doesNotMatch(
    workflow,
    /\bapp_(?:name|slug)\b|owner_username|OWNER_USERNAME|inputs\.(?:add_scopes|environment)/i,
    `${name} must not select authority through names or caller-defined authority`,
  );
}

// Execute the actual closed shell registry: a swapped destination or an
// accepted unknown ID must fail, including when scopes and names look valid.
const activityDestinations = [
  ['71ea45cf97451563762ead13', 'oxy-asset-variant-worker', 'OXY_ACTIVITY_API'],
  ['ed143b1b58d60eab417f7d5c', 'nilo', 'OXY_SERVICE_API'],
  ['6a2f851751b784a86fd0e94f', 'website-api', 'OXY_SERVICE_API'],
  ['6a2f851751b784a86fd0e92b', 'allo', 'ALLO_OXY_SERVICE_API'],
  ['6a2f851751b784a86fd0e958', 'peable', 'OXY_SERVICE_API'],
  ['6a6947b30fe72510b411252f', 'crowdsource', 'OXY_SERVICE_API'],
  ['6a396f5c2ccd7e7831cb6a31', 'moovo', 'OXY_SERVICE_API'],
  ['6a2f851751b784a86fd0e93d', 'syra', 'OXY_SERVICE_API'],
  ['6a2f851751b784a86fd0e946', 'tnp', 'OXY_SERVICE_API'],
];
const registryStart = provision.indexOf('case "$APP_ID" in');
const registryEnd = provision.indexOf('esac', registryStart) + 4;
assert.ok(registryStart >= 0 && registryEnd > registryStart);
const registryShell = provision.slice(registryStart, registryEnd);
for (const [appId, namespace, prefix] of activityDestinations) {
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `${registryShell}\nprintf "%s\\n" "$APP_NAMESPACE" "$SCOPES" "$DESTINATION_KEY_NAME" "$DESTINATION_SECRET_NAME" "$CREDENTIAL_NAME" "$ISOLATE_CREDENTIAL_NAME"`,
    ],
    {
      env: { ...process.env, APP_ID: appId },
      encoding: 'utf8',
    },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(execution.stdout.trim().split('\n'), [
    namespace,
    'user:read',
    `${prefix}_KEY`,
    `${prefix}_SECRET`,
    'Ecosystem activity (production)',
    'true',
  ]);
}
for (const appId of ['website-api', '6a2f851751b784a86fd0e94f-extra', 'ffffffffffffffffffffffff']) {
  const execution = spawnSync('bash', ['-c', registryShell], {
    env: { ...process.env, APP_ID: appId },
    encoding: 'utf8',
  });
  assert.notEqual(execution.status, 0, `unregistered application accepted: ${appId}`);
}

const homiioActivity = spawnSync(
  'bash',
  [
    '-c',
    `${registryShell}
printf "%s\\n" "$APP_NAMESPACE" "$SCOPES" "$CREDENTIAL_NAME" "$ISOLATE_CREDENTIAL_NAME" "$DESTINATION_KEY_NAME" "$DESTINATION_SECRET_NAME"`,
  ],
  {
    env: {
      ...process.env,
      APP_ID: canonicalHomiioApplicationId,
      CREDENTIAL_LANE: 'activity',
    },
    encoding: 'utf8',
  },
);
assert.equal(homiioActivity.status, 0, homiioActivity.stderr);
assert.deepEqual(homiioActivity.stdout.trim().split('\n'), [
  'homiio',
  'user:read',
  'Ecosystem activity (production)',
  'true',
  'OXY_ACTIVITY_API_KEY',
  'OXY_ACTIVITY_API_SECRET',
]);

// Execute the registry after its defaults: rotation authority must come out of
// the exact-ID arm per lane, and Homiio's activity lane must never inherit the
// service lane's rotation.
const defaultedRegistryShell = provision.slice(
  registryStart,
  provision.indexOf('          if [[ ! "$SCOPES" =~', registryEnd),
);
function resolveLane(appId, lane) {
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `${defaultedRegistryShell}
printf "%s\n" "$APP_NAMESPACE" "$SCOPES" "$CREDENTIAL_NAME" "$ISOLATE_CREDENTIAL_NAME" "$ROTATE_SCOPE_MISMATCH" "$ROLLOUT_SERVICE" "$DESTINATION_KEY_NAME" "$DESTINATION_SECRET_NAME"`,
    ],
    {
      env: { ...process.env, APP_ID: appId, CREDENTIAL_LANE: lane },
      encoding: 'utf8',
    },
  );
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout.split('\n').slice(0, 8);
}
assert.deepEqual(resolveLane(canonicalHomiioApplicationId, 'service'), [
  'homiio',
  'reputation:write,inference:invoke',
  'Service (production)',
  'true',
  'true',
  '',
  'OXY_SERVICE_API_KEY',
  'OXY_SERVICE_API_SECRET',
]);
assert.deepEqual(resolveLane(canonicalHomiioApplicationId, 'activity'), [
  'homiio',
  'user:read',
  'Ecosystem activity (production)',
  'true',
  'false',
  '',
  'OXY_ACTIVITY_API_KEY',
  'OXY_ACTIVITY_API_SECRET',
]);
assert.deepEqual(resolveLane(canonicalAliaApplicationId, 'service').slice(1, 6), [
  'user:read,inference:invoke,capabilities:read,capability-tickets:issue,clarity:search,clarity:index',
  'Oxy service (production)',
  'true',
  'true',
  'alia',
]);

// The script-side rotation registry and the workflow registry must agree
// exactly: every registered rotation lane is what the workflow configures for
// that id, and no workflow arm enables rotation without a registry entry.
const registeredRotations = [
  ...scopeRotationRegistry.matchAll(
    /applicationId: "([^"]+)",\s*environment: "production",\s*credentialName: "([^"]+)",\s*scopes: Object\.freeze\(\[([^\]]*)\]\)/g,
  ),
].map(([, appId, credentialName, scopes]) => ({
  appId,
  credentialName,
  scopes: [...scopes.matchAll(/"([^"]+)"/g)].map(([, scope]) => scope).sort(),
}));
assert.deepEqual(
  registeredRotations.map(({ appId }) => appId).sort(),
  [canonicalAliaApplicationId, canonicalHomiioApplicationId].sort(),
  'scope rotation registry must be exactly the reviewed Alia and Homiio lanes',
);
for (const { appId, credentialName, scopes } of registeredRotations) {
  const [, laneScopes, laneName, isolate, rotate] = resolveLane(appId, 'service');
  assert.equal(laneName, credentialName);
  assert.deepEqual(laneScopes.split(',').sort(), scopes);
  assert.equal(isolate, 'true');
  assert.equal(rotate, 'true');
}
const rotatingArms = [...registryShell.matchAll(/\n\s+([0-9a-f-]+)\)\n([\s\S]*?)\n\s+;;/g)]
  .filter(([, , body]) => /ROTATE_SCOPE_MISMATCH="true"/.test(body))
  .map(([, appId]) => appId)
  .sort();
assert.deepEqual(rotatingArms, registeredRotations.map(({ appId }) => appId).sort());

const kaanaProvision = registryArm(provision, canonicalKaanaApplicationId);
const homiioProvision = registryArm(provision, canonicalHomiioApplicationId);
const aliaProvision = registryArm(provision, canonicalAliaApplicationId);
const mentionProvision = registryArm(provision, canonicalMentionApplicationId);
assert.match(kaanaProvision, /SCOPES="inference:byok:validate"/);
assert.match(kaanaProvision, /APP_NAMESPACE="kaana"/);
assert.match(kaanaProvision, /DESTINATION_KEY_NAME="OXY_APPLICATION_KEY"/);
assert.match(kaanaProvision, /DESTINATION_SECRET_NAME="OXY_APPLICATION_SECRET"/);
assert.doesNotMatch(kaanaProvision, /homiio|OXY_SERVICE_API_/i);
assert.match(homiioProvision, /SCOPES="reputation:write,inference:invoke"/);
assert.match(homiioProvision, /APP_NAMESPACE="homiio"/);
assert.match(homiioProvision, /DESTINATION_KEY_NAME="OXY_SERVICE_API_KEY"/);
assert.match(homiioProvision, /DESTINATION_SECRET_NAME="OXY_SERVICE_API_SECRET"/);
assert.doesNotMatch(homiioProvision, /kaana|OXY_APPLICATION_/i);
assert.match(aliaProvision, /APP_NAMESPACE="alia"/);
assert.match(aliaProvision, /DESTINATION_KEY_NAME="OXY_SERVICE_API_KEY"/);
assert.match(aliaProvision, /DESTINATION_SECRET_NAME="OXY_SERVICE_API_SECRET"/);
assert.match(aliaProvision, /ISOLATE_CREDENTIAL_NAME="true"/);
assert.match(aliaProvision, /ROTATE_SCOPE_MISMATCH="true"/);
assert.match(aliaProvision, /ROLLOUT_SERVICE="alia"/);
assert.match(
  aliaProvision,
  /SCOPES="user:read,inference:invoke,capabilities:read,capability-tickets:issue,clarity:search,clarity:index"/,
);
assert.doesNotMatch(
  aliaProvision,
  /inference:(?:models|usage|routing):read|acting-as:offline|accounts:act-as-session/,
);
assert.doesNotMatch(aliaProvision, /ALIA_(?:RELAY|KAANA)_CREDENTIAL/);
assert.doesNotMatch(kaanaProvision, /ROTATE_SCOPE_MISMATCH|ROLLOUT_SERVICE/);
assert.match(homiioProvision, /ISOLATE_CREDENTIAL_NAME="true"/);
assert.doesNotMatch(homiioProvision, /ISOLATE_CREDENTIAL_NAME="false"/);
assert.match(homiioProvision, /ROTATE_SCOPE_MISMATCH="true"/);
assert.doesNotMatch(homiioProvision, /ROLLOUT_SERVICE/);
// Mention attests its ECS task roles (ADR 0026) and holds no Oxy key pair, so
// no lane may mint one back into /oxy/mention/OXY_SERVICE_API_*. Its web app is
// measured from Cloudflare analytics, so its arm is an unconditional refusal.
assert.doesNotMatch(
  mentionProvision,
  /APP_NAMESPACE=|CREDENTIAL_LANE|SCOPES=|DESTINATION_(?:KEY|SECRET)_NAME|OXY_SERVICE_API_|ROTATE_SCOPE_MISMATCH|ROLLOUT_SERVICE/,
);
for (const lane of ['service', 'activity']) {
  const execution = spawnSync('bash', ['-c', registryShell], {
    env: { ...process.env, APP_ID: canonicalMentionApplicationId, CREDENTIAL_LANE: lane },
    encoding: 'utf8',
  });
  assert.notEqual(execution.status, 0, `Mention ${lane} key pair provisioning was accepted`);
  assert.match(execution.stdout, /Mention authenticates as its ECS task role/);
}
assert.match(provision, /\/oxy\/\$APP_NAMESPACE\/\$DESTINATION_KEY_NAME/);
assert.match(provision, /\/oxy\/\$APP_NAMESPACE\/\$DESTINATION_SECRET_NAME/);
assert.doesNotMatch(provision, /\/oxy\/\$APP_NAMESPACE\/OXY_APPLICATION_(?:KEY|SECRET)/);
assert.match(provision, /verify-reused-service-credential\.sh/);
assert.match(provision, /--force-new-deployment/);
assert.match(provision, /aws ecs wait services-stable/);
assert.doesNotMatch(
  provision,
  /inputs\.(?:credential_id|credential_name|scopes|rollout_service)/,
  'rotation authority and its consumer must come only from the exact-id registry',
);
assert.match(provision, /::group::credential task scoped CloudWatch log/);
assert.match(
  provision,
  /select\(startswith\("SERVICE_CRED_JSON="\) \| not\)/,
  'failed task logs must be shown without echoing a credential result envelope',
);
assert.doesNotMatch(
  provision,
  /existing exact service credential and destination SecureStrings are already present/,
);
assert.equal(
  provision.match(/put-secure-parameter\.sh/g)?.length,
  4,
  'the envelope key, task binding and both recovery-package paths must use the stdin-only SSM writer',
);
assert.equal(
  handoffScript.match(/put-secure-parameter\.sh/g)?.length,
  2,
  'both destination values must use the stdin-only SSM writer',
);
assert.match(provision, /stale_temp_parameter recovery requires dry_run=false/);
assert.match(provision, /schemaVersion:1/);
assert.match(provision, /preserve_temp_parameter="true"/);
assert.match(provision, /handoff-service-credential-pair\.sh/);
assert.doesNotMatch(provision, /aws ecs list-tasks|taskArns\[-1\]|--desired-status/);
assert.match(provision, /binding_parameter="\$temp_parameter-binding"/);
assert.match(provision, /\.runAttempt == \$run_attempt/);
assert.match(provision, /--started-by "gh-svc-cred-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
assert.match(provision, /missing encrypted recovery secret/);
assert.match(provision, /recovery package write failed/);
assert.doesNotMatch(provision, /removed legacy stale credential envelope key/);
assert.doesNotMatch(
  provision,
  /aws ssm put-parameter|--value\s+"\$(?:OUTPUT_ENCRYPTION_KEY|public_key|secret)"/,
  'the workflow must not put credential values in aws argv',
);
assert.match(secureParameterScript, /--value file:\/\/\/dev\/stdin/);
assert.doesNotMatch(secureParameterScript, /--cli-input-json\s+file:/);

const inboxReconcile = registryArm(reconcile, canonicalInboxApplicationId);
const homiioReconcile = registryArm(reconcile, canonicalHomiioApplicationId);
const aliaReconcile = registryArm(reconcile, canonicalAliaApplicationId);
assert.match(inboxReconcile, new RegExp(canonicalInboxCredentialId));
assert.match(inboxReconcile, /ADD_SCOPES="inference:invoke"/);
assert.match(homiioReconcile, /ADD_SCOPES="reputation:write,inference:invoke"/);
// Alia's coordinator scope and its Clarity search and page reads are added in
// place: execution authorizations bind the coordinator credential id, so the
// reconcile arm must never widen past those three.
assert.match(aliaReconcile, /ADD_SCOPES="capability-tickets:issue,clarity:search,clarity:index"/);
assert.match(reconcile, /CREDENTIAL_ID.*EXPECTED_CREDENTIAL_ID/);
// Mention's authority is its workload binding's, which this script cannot
// select: the reconcile registry must refuse its application id outright.
const reconcileRegistryStart = reconcile.indexOf('case "$APP_ID" in');
const reconcileRegistryShell = reconcile.slice(
  reconcileRegistryStart,
  reconcile.indexOf('esac', reconcileRegistryStart) + 4,
);
assert.ok(reconcileRegistryStart >= 0);
assert.doesNotMatch(
  reconcileRegistryShell,
  new RegExp(`\\n\\s+${canonicalMentionApplicationId}\\)`),
);
const mentionReconcile = spawnSync('bash', ['-c', reconcileRegistryShell], {
  env: { ...process.env, APP_ID: canonicalMentionApplicationId },
  encoding: 'utf8',
});
assert.notEqual(mentionReconcile.status, 0, 'Mention credential reconciliation was accepted');

assert.match(
  reconcileScript,
  /eq\(applications\.id, appId\)/,
  'reconcile must select the exact application id',
);
assert.match(
  reconcileScript,
  /eq\(applicationCredentials\.id, credentialId\)/,
  'reconcile must select the exact credential id',
);
assert.match(
  reconcileScript,
  /applications\.ownerAccountId/,
  'reconcile must derive owner attribution from the exact application row',
);
assert.doesNotMatch(
  reconcileScript,
  /users\.username|createdByUserId|OWNER_USERNAME/,
  'reconcile must not derive authority from a human name or creator attribution',
);
assert.match(reconcileScript, /requiredExactIdentifier\("APP_ID"\)/);
assert.match(reconcileScript, /requiredExactIdentifier\("CREDENTIAL_ID"\)/);
assert.doesNotMatch(reconcileScript, /const appId = required\("APP_ID"\)/);
assert.doesNotMatch(reconcileScript, /const credentialId = required\("CREDENTIAL_ID"\)/);
assert.match(provisionScript, /const requestedAppId = process\.env\.APP_ID;/);
assert.match(provisionScript, /ISOLATE_CREDENTIAL_NAME/);
assert.match(provisionScript, /ROTATE_SCOPE_MISMATCH requires ISOLATE_CREDENTIAL_NAME=true/);
assert.match(
  provisionScript,
  /ROTATE_SCOPE_MISMATCH is not registered for this exact application credential lane/,
);
assert.match(
  provisionScript,
  /rotateScopeMismatch &&\s*!isRegisteredScopeRotation\(\{\s*applicationId: requestedAppId,\s*environment,\s*credentialName,\s*scopes,\s*\}\)/,
  'prepare must refuse rotation outside the closed exact-lane registry',
);
assert.match(scopeRotationRegistry, new RegExp(canonicalAliaApplicationId));
assert.match(scopeRotationRegistry, new RegExp(canonicalHomiioApplicationId));
assert.match(provisionScript, /rotatedFromCredentialId: rotatedFrom\?\.id/);
assert.match(provisionScript, /status: rotateScopeMismatch \? "pending" : "active"/);
assert.doesNotMatch(provisionScript, /status: "deprecated"/);
assert.match(finalizeScript, /status: "deprecated", expiresAt: graceExpiresAt/);
assert.match(finalizeScript, /status: "active"/);
assert.match(finalizeScript, /eventType: "rotated"/);
assert.match(finalizeScript, /eventType: "created"/);
assert.match(finalizeScript, /effectiveUntil: graceExpiresAt/);
assert.match(
  finalizeScript,
  /const lane = findRegisteredScopeRotation\(appId\);\s*if \(!appId \|\| !lane\)/,
  'finalize must refuse application ids outside the closed rotation registry',
);
assert.doesNotMatch(finalizeScript, /6a2f851751b784a86fd0e9|ALIA_/);
assert.match(finalizeScript, /FINALIZE_CREDENTIAL_ID/);
assert.match(provisionScript, /const result = await getDb\(\)\.transaction/);
assert.match(provisionScript, /writeResult\(result\);/);
assert.match(provision, /after emitting commit evidence; continuing recoverably/);
const packageWrite = provision.indexOf('"$temp_parameter" overwrite');
const finalizeCall = provision.lastIndexOf('finalize_credential "$(jq -er');
const destinationHandoff = provision.lastIndexOf('handoff-service-credential-pair.sh');
assert.ok(packageWrite >= 0 && finalizeCall > packageWrite);
assert.ok(destinationHandoff > finalizeCall);

process.stdout.write(
  'Service credential workflows bind exact app/credential IDs, scopes, and SSM destinations.\n',
);

const niloSpecSource = readFileSync('packages/api/src/scripts/seedOxyApplicationsSpecs.ts', 'utf8');
const niloId = niloSpecSource.match(/export const NILO_APPLICATION_ID = '([a-f0-9]{24})'/)?.[1];
assert.ok(niloId);
assert.ok(activityDestinations.some(([id, namespace]) => id === niloId && namespace === 'nilo'));

const mediaId = niloSpecSource.match(
  /export const MEDIA_WORKER_APPLICATION_ID = '([a-f0-9]{24})'/,
)?.[1];
assert.ok(mediaId);
assert.ok(
  activityDestinations.some(
    ([id, namespace]) => id === mediaId && namespace === 'oxy-asset-variant-worker',
  ),
);

// The Cloudflare edge lane is retired (it was never run): web traffic is read
// keylessly from Cloudflare analytics by oxy-api, so no Worker or Pages project
// holds an Oxy key pair. The lane guard refuses it before the exact-ID registry,
// and the applications that were registered for it alone are unregistered.
assert.doesNotMatch(
  provision,
  /deliver-edge-activity|edge-activity-targets|OXY_EDGE_ACTIVITY_|edge_activity_enabled|Edge activity \(production\)|^\s+- edge$/m,
);
const laneGuardStart = provision.indexOf('case "$CREDENTIAL_LANE" in');
assert.ok(laneGuardStart >= 0 && laneGuardStart < registryStart);
const guardedRegistryShell = provision.slice(laneGuardStart, registryEnd);
function runGuarded(appId, lane) {
  return spawnSync('bash', ['-c', guardedRegistryShell], {
    env: { ...process.env, APP_ID: appId, CREDENTIAL_LANE: lane },
    encoding: 'utf8',
  });
}
const retiredEdgeOnlyApplications = [
  '6a37d0cc5d4b5f15482a9340', // mercaria
  '6a37b3e71ddfd195b65681d2', // noted
  '019fe305-3543-750c-997f-650db85b2dec', // atlas
  '6a37b3e61ddfd195b656819b', // inbox
  '01a0646a-2382-74a3-a795-788924d55722', // clarity
  '6a2f851651b784a86fd0e8d1', // accounts
  '6a2f851751b784a86fd0e905', // auth
  '6a2f851751b784a86fd0e8e3', // console
];
for (const appId of [
  ...retiredEdgeOnlyApplications,
  canonicalMentionApplicationId,
  canonicalHomiioApplicationId,
  ...activityDestinations.map(([id]) => id),
]) {
  const edge = runGuarded(appId, 'edge');
  assert.notEqual(edge.status, 0, `edge lane accepted for ${appId}`);
  assert.match(edge.stdout, /edge credential lane is retired/);
}
for (const appId of retiredEdgeOnlyApplications) {
  assert.doesNotMatch(registryShell, new RegExp(`\\n\\s+${appId}\\)`));
  for (const lane of ['service', 'activity']) {
    const execution = runGuarded(appId, lane);
    assert.notEqual(execution.status, 0, `retired edge-only application ${appId} accepted`);
    assert.match(execution.stdout, /not registered for service credential delivery/);
  }
}
for (const lane of ['', 'Edge', 'service,edge']) {
  assert.notEqual(runGuarded(canonicalKaanaApplicationId, lane).status, 0, `lane ${lane} accepted`);
}
assert.equal(runGuarded(canonicalKaanaApplicationId, 'service').status, 0);
assert.equal(runGuarded(canonicalHomiioApplicationId, 'activity').status, 0);
