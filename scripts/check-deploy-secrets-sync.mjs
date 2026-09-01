#!/usr/bin/env node
/**
 * Fail the build when a secret the API needs at boot would never reach SSM.
 *
 * THE BUG THIS EXISTS FOR
 *
 * `.github/workflows/deploy-aws.yml` copies GitHub secrets into SSM through two
 * hand-maintained allowlists that have to agree: a `SYNC_<NAME>` env block, and
 * the `SHARED_SECRETS` / `API_SECRETS` name lists the sync loop iterates. A name
 * missing from either one fails SILENTLY — the loop just never writes that
 * parameter, the deploy step goes green, and the failure surfaces later and
 * somewhere else, as `ResourceInitializationError: unable to pull secrets` when
 * ECS launches a task whose definition references the parameter that was never
 * created.
 *
 * `DATABASE_URL` was in neither list. Nothing anywhere would have said so.
 *
 * WHAT IS CHECKED
 *
 *   1. The two allowlists are consistent with each other: every `SYNC_<NAME>`
 *      is in exactly one name list, every listed name has a `SYNC_<NAME>`, and
 *      each `SYNC_<NAME>` reads `secrets.<NAME>` — not some other secret.
 *   2. Every environment variable `validateRequiredEnvVars()` requires at boot
 *      (`packages/api/src/config/env.ts`) is either synced, or named in
 *      SUPPLIED_WITHOUT_SECRET_SYNC below with the reason it is not a secret.
 *
 * (2) is the half that catches the `DATABASE_URL` shape, and it is anchored on
 * the API's own boot contract rather than on a second copy of the list — the
 * moment a required env var is added, this goes red and names it.
 *
 * WHAT IS NOT CHECKED, DELIBERATELY
 *
 * Whether the ECS task definition REFERENCES the SSM parameter. That lives in
 * terraform in `oxy-infra`, not in this repo, and reaching AWS from a PR check
 * would mean handing pull requests deploy credentials. So this gate covers
 * "required at boot ⇒ written to SSM"; the task definition's own reference list
 * is oxy-infra's to guard. The two together are the full chain; this is the end
 * of it that lives here.
 *
 * Paths are resolved from the working directory, so the fixture tests in
 * `scripts/test-check-deploy-secrets-sync.mjs` can run it against a mutated
 * copy of the real files.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_PATH = join('.github', 'workflows', 'deploy-aws.yml');
const ENV_MODULE_PATH = join('packages', 'api', 'src', 'config', 'env.ts');

/**
 * Required env vars that are deliberately NOT GitHub secrets, with the reason.
 * Anything required at boot and absent from both this map and the sync lists is
 * a hard failure — which is the point: a new required variable forces an
 * explicit decision instead of a silent omission.
 */
const SUPPLIED_WITHOUT_SECRET_SYNC = new Map([
  [
    'AWS_REGION',
    'not a secret — a plain region string set directly in the ECS task ' +
    'definition (oxy-infra terraform-uswest2), never stored in SSM',
  ],
]);

/**
 * Env vars that are production-mandatory but validated OUTSIDE the `required`
 * array in `validateRequiredEnvVars()` — still secrets that MUST reach SSM.
 * DEVICE_ID_SALT lives here: production boot fails without it, but dev installs
 * a placeholder, so it cannot sit in `required` without breaking local runs.
 */
const PRODUCTION_MANDATORY_SYNCED_SECRETS = ['DEVICE_ID_SALT'];

/**
 * Vacuity guards for the boot-contract parse — and ONLY for that parse.
 *
 * The two workflow allowlists check each OTHER, so a regex that degrades on
 * that side is already loud: every name it fails to see is reported as missing
 * from the other list. Adding count floors there would be machinery for a
 * failure that cannot occur, which reads as load-bearing to the next person.
 *
 * `required` in env.ts has no such counterpart. If that regex ever matched a
 * SHORTER array — a refactor splitting the list, a second `required:` earlier
 * in the file — the gate would silently stop checking the names it no longer
 * sees and report "0 problems". These two guards are the only thing standing
 * between that and a false green, and `test-check-deploy-secrets-sync.mjs`
 * covers each with a case that goes green if the guard is deleted.
 */
const MINIMUM_REQUIRED_ENV_VARS = 5;
// `DATABASE_URL`, not `MONGODB_URI`: the sentinel has to be a name that will
// still be in the required array. MONGODB_URI left the serving path on
// 2026-08-02 and is no longer synced to ECS — only backfill/admin scripts read
// it locally — so the sentinel moved rather than being dropped.
const REQUIRED_ENV_SENTINEL = 'DATABASE_URL';

const problems = [];

function fail(message) {
  problems.push(message);
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`Cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
}

/** `SYNC_<NAME>: ${{ secrets.<SECRET> }}` entries, as a map of NAME -> SECRET. */
function parseSyncEntries(workflow) {
  const entries = new Map();
  const pattern = /^\s+SYNC_([A-Z0-9_]+):\s*\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}\s*$/gm;
  for (const match of workflow.matchAll(pattern)) {
    const [, name, secret] = match;
    if (entries.has(name)) fail(`deploy-aws.yml declares SYNC_${name} more than once.`);
    entries.set(name, secret);
  }
  return entries;
}

/** A `NAME="a b c"` shell assignment in the sync step, as an array of names. */
function parseSecretList(workflow, variable) {
  const match = workflow.match(new RegExp(`^\\s*${variable}="([^"]*)"`, 'm'));
  if (!match) {
    fail(`deploy-aws.yml no longer contains a ${variable}="..." assignment; the gate cannot read the allowlist.`);
    return [];
  }
  return match[1].split(/\s+/).filter(Boolean);
}

/** The names in `validateRequiredEnvVars()`'s `required` array. */
function parseRequiredEnvVars(envModule) {
  const block = envModule.match(/const required:\s*\(keyof RequiredEnvVars\)\[\]\s*=\s*\[([\s\S]*?)\];/);
  if (!block) {
    fail(`${ENV_MODULE_PATH} no longer declares \`const required: (keyof RequiredEnvVars)[] = [...]\`; the gate cannot read the boot contract.`);
    return [];
  }
  return [...block[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((match) => match[1]);
}

const workflow = read(WORKFLOW_PATH);
const envModule = read(ENV_MODULE_PATH);

const syncEntries = parseSyncEntries(workflow);
const sharedSecrets = parseSecretList(workflow, 'SHARED_SECRETS');
const apiSecrets = parseSecretList(workflow, 'API_SECRETS');
const requiredEnvVars = parseRequiredEnvVars(envModule);

// ── Vacuity guards (boot-contract parse only — see the constants above) ────
if (requiredEnvVars.length > 0 && requiredEnvVars.length < MINIMUM_REQUIRED_ENV_VARS) {
  fail(`Only ${requiredEnvVars.length} required env vars parsed out of ${ENV_MODULE_PATH} (expected at least ${MINIMUM_REQUIRED_ENV_VARS}). The parse is broken, not the source.`);
}
if (requiredEnvVars.length > 0 && !requiredEnvVars.includes(REQUIRED_ENV_SENTINEL)) {
  fail(`${REQUIRED_ENV_SENTINEL} was not among the parsed required env vars — the gate is reading the wrong array in ${ENV_MODULE_PATH}.`);
}

// ── 1. The two allowlists must agree ───────────────────────────────────────
const listed = new Map();
for (const [listName, names] of [['SHARED_SECRETS', sharedSecrets], ['API_SECRETS', apiSecrets]]) {
  for (const name of names) {
    const previous = listed.get(name);
    if (previous) {
      fail(`${name} appears in both ${previous} and ${listName}; the sync loop would write it twice, to two different SSM paths.`);
      continue;
    }
    listed.set(name, listName);
  }
}

for (const [name, secret] of syncEntries) {
  if (secret !== name) {
    fail(`SYNC_${name} reads \${{ secrets.${secret} }}; it must read \${{ secrets.${name} }}, or the sync writes the wrong value under that name.`);
  }
  if (!listed.has(name)) {
    fail(`${name} has a SYNC_${name} env entry but is in neither SHARED_SECRETS nor API_SECRETS, so the sync loop never writes it to SSM.`);
  }
}

for (const [name, listName] of listed) {
  if (!syncEntries.has(name)) {
    fail(`${name} is in ${listName} but has no \`SYNC_${name}: \${{ secrets.${name} }}\` env entry, so the loop reads an empty value and skips it as a placeholder.`);
  }
}

// ── 2. Everything the API requires at boot must be reachable ───────────────
for (const name of requiredEnvVars) {
  if (listed.has(name)) continue;
  if (SUPPLIED_WITHOUT_SECRET_SYNC.has(name)) continue;
  fail(
    `${name} is required at boot by validateRequiredEnvVars() but deploy-aws.yml never syncs it to SSM. ` +
    `Add \`SYNC_${name}: \${{ secrets.${name} }}\` and put ${name} in SHARED_SECRETS or API_SECRETS — ` +
    'or, if it is not a secret, record why in SUPPLIED_WITHOUT_SECRET_SYNC in ' +
    'scripts/check-deploy-secrets-sync.mjs.'
  );
}

for (const name of PRODUCTION_MANDATORY_SYNCED_SECRETS) {
  if (listed.has(name)) continue;
  fail(
    `${name} is production-mandatory (validateRequiredEnvVars) but deploy-aws.yml never syncs it to SSM. ` +
    `Add \`SYNC_${name}: \${{ secrets.${name} }}\` and put ${name} in SHARED_SECRETS or API_SECRETS.`
  );
}

for (const name of SUPPLIED_WITHOUT_SECRET_SYNC.keys()) {
  if (listed.has(name)) {
    fail(`${name} is recorded as supplied without a secret sync, but deploy-aws.yml also syncs it. Remove one of the two.`);
  }
}

if (problems.length > 0) {
  console.error('Deploy secret sync is BROKEN:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    '\nA name missing from either allowlist is never written to SSM and never reported;' +
    '\nthe ECS task then fails to start with `ResourceInitializationError: unable to pull secrets`.'
  );
  process.exit(1);
}

console.log(
  `Deploy secret sync is consistent: ${syncEntries.size} SYNC_* entries match ${listed.size} listed secrets, ` +
  `all ${requiredEnvVars.length} boot-required env vars are accounted for, ` +
  `and all ${PRODUCTION_MANDATORY_SYNCED_SECRETS.length} production-mandatory secrets are synced.`
);
