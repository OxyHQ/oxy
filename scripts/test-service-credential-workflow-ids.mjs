#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const canonicalKaanaApplicationId = '68b7c4e19f2a6d0e3c8b5174';
const canonicalHomiioApplicationId = '6a2f851751b784a86fd0e922';
const canonicalInboxApplicationId = '6a37b3e61ddfd195b656819b';
const canonicalInboxCredentialId = '01a06134-022c-72b6-a876-27da37a39e39';
const canonicalAliaApplicationId = '6a2f851751b784a86fd0e934';

const provision = readFileSync('.github/workflows/provision-service-credential.yml', 'utf8');
const reconcile = readFileSync(
  '.github/workflows/reconcile-service-credential-authority.yml',
  'utf8',
);
const reconcileScript = readFileSync(
  'packages/api/scripts/reconcile-service-credential-authority.ts',
  'utf8',
);
const provisionScript = readFileSync(
  'packages/api/scripts/create-service-credential.ts',
  'utf8',
);
const secureParameterScript = readFileSync(
  '.github/scripts/put-secure-parameter.sh',
  'utf8',
);

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

const kaanaProvision = registryArm(provision, canonicalKaanaApplicationId);
const homiioProvision = registryArm(provision, canonicalHomiioApplicationId);
const aliaProvision = registryArm(provision, canonicalAliaApplicationId);
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
assert.match(
  aliaProvision,
  /SCOPES="user:read,inference:invoke"/,
);
assert.doesNotMatch(
  aliaProvision,
  /inference:(?:models|usage|routing):read|acting-as:offline|accounts:act-as-session/,
);
assert.doesNotMatch(aliaProvision, /ALIA_(?:RELAY|KAANA)_CREDENTIAL/);
assert.match(provision, /\/oxy\/\$APP_NAMESPACE\/\$DESTINATION_KEY_NAME/);
assert.match(provision, /\/oxy\/\$APP_NAMESPACE\/\$DESTINATION_SECRET_NAME/);
assert.doesNotMatch(provision, /\/oxy\/\$APP_NAMESPACE\/OXY_APPLICATION_(?:KEY|SECRET)/);
assert.match(provision, /verify-reused-service-credential\.sh/);
assert.match(provision, /::group::credential task scoped CloudWatch log/);
assert.match(
  provision,
  /select\(startswith\("SERVICE_CRED_JSON="\) \| not\)/,
  'failed task logs must be shown without echoing a credential result envelope',
);
assert.doesNotMatch(provision, /existing exact service credential and destination SecureStrings are already present/);
assert.equal(
  provision.match(/put-secure-parameter\.sh/g)?.length,
  3,
  'all three credential values must use the stdin-only SSM writer',
);
assert.doesNotMatch(
  provision,
  /aws ssm put-parameter|--value\s+"\$(?:OUTPUT_ENCRYPTION_KEY|public_key|secret)"/,
  'the workflow must not put credential values in aws argv',
);
assert.match(secureParameterScript, /--value file:\/\/\/dev\/stdin/);
assert.doesNotMatch(secureParameterScript, /--cli-input-json\s+file:/);

const inboxReconcile = registryArm(reconcile, canonicalInboxApplicationId);
const homiioReconcile = registryArm(reconcile, canonicalHomiioApplicationId);
assert.match(inboxReconcile, new RegExp(canonicalInboxCredentialId));
assert.match(inboxReconcile, /ADD_SCOPES="inference:invoke"/);
assert.match(homiioReconcile, /ADD_SCOPES="reputation:write,inference:invoke"/);
assert.match(reconcile, /CREDENTIAL_ID.*EXPECTED_CREDENTIAL_ID/);

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

process.stdout.write('Service credential workflows bind exact app/credential IDs, scopes, and SSM destinations.\n');
