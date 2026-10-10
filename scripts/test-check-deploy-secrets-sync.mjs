#!/usr/bin/env node

/**
 * Exercises check-deploy-secrets-sync.mjs against mutated copies of the REAL
 * files it guards.
 *
 * Fixtures are copies, not hand-written miniatures: a synthetic workflow would
 * drift away from `deploy-aws.yml` and start proving something about the
 * fixture instead of about the deploy. Each case copies the real workflow, the
 * real `.github/scripts/` and the real env module into a temp root, breaks
 * exactly one thing, and asserts the gate goes red AND names what broke — a
 * gate that fails without naming it is a gate nobody can act on.
 *
 * The first broken case restores the step that existed until 2026-10-10 and
 * copied GitHub repo secrets into SSM on every deploy, byte for byte in shape.
 * The vacuity cases at the end each pass (exit 0) if their guard is deleted,
 * so no guard can rot into decoration.
 *
 * Offline and dependency-free. Fixtures are created under the OS temp dir.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkScript = join(repoRoot, 'scripts', 'check-deploy-secrets-sync.mjs');
const WORKFLOW = join('.github', 'workflows', 'deploy-aws.yml');
const SCRIPTS = join('.github', 'scripts');
const ENV_MODULE = join('packages', 'api', 'src', 'config', 'env.ts');
const ROLLOUT_SCRIPT = join(SCRIPTS, 'deploy-ecs-image.sh');

const fixturePrefix = join(tmpdir(), 'oxy-deploy-secrets-');
const createdFixtures = [];
const failures = [];

function createFixture() {
  const root = mkdtempSync(fixturePrefix);
  createdFixtures.push(root);
  for (const relative of [WORKFLOW, ENV_MODULE, SCRIPTS]) {
    mkdirSync(join(root, dirname(relative)), { recursive: true });
    cpSync(join(repoRoot, relative), join(root, relative), { recursive: true });
  }
  return root;
}

/** Rewrite a fixture file, failing loudly if the edit matched nothing. */
function edit(root, relative, caseName, replacer) {
  const path = join(root, relative);
  const before = readFileSync(path, 'utf8');
  const after = replacer(before);
  if (after === before) {
    failures.push(`${caseName}: the fixture edit changed nothing — the mutation never happened, so the case proves nothing.`);
    return;
  }
  writeFileSync(path, after);
}

function expectVerdict(caseName, root, expectedCode, expectedFragment) {
  let code = 0;
  let output = '';
  try {
    output = execFileSync('node', [checkScript], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (code !== expectedCode) {
    failures.push(`${caseName}: expected exit ${expectedCode}, got ${code}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(`${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`);
  }
}

/** Insert a step right before the ECR login, which every deploy runs. */
const ECR_LOGIN = '      - name: Login to ECR\n';
function addStep(text, step) {
  return text.replace(ECR_LOGIN, `${step}\n${ECR_LOGIN}`);
}

// The real files must pass, or nothing below means anything.
expectVerdict('unchanged', createFixture(), 0, 'Deploy secrets are SSM-only');

// ── 1. No SSM write, directly or through a script the deploy runs ───────────
//
// The step removed on 2026-10-10, in its own shape: a repo secret read into
// the environment and piped into the SSM writer.
const syncRestored = createFixture();
edit(syncRestored, WORKFLOW, 'sync-step-restored', (text) =>
  addStep(
    text,
    '      - name: Sync API deployment secrets -> SSM\n' +
      '        env:\n' +
      '          SYNC_DATABASE_URL: ${{ secrets.DATABASE_URL }}\n' +
      '        run: |\n' +
      '          printf \'%s\' "$SYNC_DATABASE_URL" | bash .github/scripts/put-secure-parameter.sh /oxy/$APP/DATABASE_URL overwrite',
  ));
expectVerdict('sync-step-restored', syncRestored, 1, 'writes or deletes an SSM parameter');
expectVerdict('sync-step-restored (secret read)', syncRestored, 1, 'deploy-aws.yml reads secrets.DATABASE_URL');

const directWrite = createFixture();
edit(directWrite, WORKFLOW, 'direct-put-parameter', (text) =>
  addStep(text, '      - name: Write one\n        run: aws ssm put-parameter --name /oxy/oxy-api/X --type SecureString --value file:///dev/stdin --overwrite'));
expectVerdict('direct-put-parameter', directWrite, 1, 'aws ssm put-parameter --name /oxy/oxy-api/X');

const directDelete = createFixture();
edit(directDelete, WORKFLOW, 'direct-delete-parameter', (text) =>
  addStep(text, '      - name: Delete one\n        run: aws ssm delete-parameter --name /oxy/oxy-api/X'));
expectVerdict('direct-delete-parameter', directDelete, 1, 'aws ssm delete-parameter --name /oxy/oxy-api/X');

// One hop removed: the rollout script itself starts writing. Nothing in the
// workflow changes, so only the transitive scan can see it.
const indirectWrite = createFixture();
edit(indirectWrite, ROLLOUT_SCRIPT, 'write-inside-rollout-script', (text) =>
  `${text}\naws ssm put-parameter --name "/oxy/$APP/X" --overwrite --value file:///dev/stdin\n`);
expectVerdict('write-inside-rollout-script', indirectWrite, 1, '.github/scripts/deploy-ecs-image.sh:');

// ── 2. No repo secret but the CI-only allowlist ────────────────────────────
const appSecretRead = createFixture();
edit(appSecretRead, WORKFLOW, 'app-secret-read', (text) =>
  addStep(text, '      - name: Read one\n        env:\n          STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}\n        run: "true"'));
expectVerdict('app-secret-read', appSecretRead, 1, 'deploy-aws.yml reads secrets.STRIPE_SECRET_KEY');

// A secret hidden inside a larger expression is still a read.
const secretInExpression = createFixture();
edit(secretInExpression, WORKFLOW, 'secret-inside-expression', (text) =>
  addStep(text, "      - name: Read one\n        env:\n          X: ${{ github.event_name == 'push' && secrets.DATABASE_URL || '' }}\n        run: \"true\""));
expectVerdict('secret-inside-expression', secretInExpression, 1, 'deploy-aws.yml reads secrets.DATABASE_URL');

const wholeContext = createFixture();
edit(wholeContext, WORKFLOW, 'whole-secrets-context', (text) =>
  addStep(text, '      - name: Read all\n        env:\n          ALL: ${{ toJSON(secrets) }}\n        run: "true"'));
expectVerdict('whole-secrets-context', wholeContext, 1, 'toJSON(secrets)');

const indexedContext = createFixture();
edit(indexedContext, WORKFLOW, 'indexed-secrets-context', (text) =>
  addStep(text, "      - name: Read one\n        env:\n          X: ${{ secrets[format('{0}', 'DATABASE_URL')] }}\n        run: \"true\""));
expectVerdict('indexed-secrets-context', indexedContext, 1, 'reads the secrets context without a literal name');

const inherited = createFixture();
edit(inherited, WORKFLOW, 'secrets-inherit', (text) =>
  text.replace('  deploy:\n', '  inherit-all:\n    uses: ./.github/workflows/ci.yml\n    secrets: inherit\n  deploy:\n'));
expectVerdict('secrets-inherit', inherited, 1, 'passes `secrets: inherit`');

// The job token is CI's own and stays allowed.
const jobToken = createFixture();
edit(jobToken, WORKFLOW, 'job-token-allowed', (text) =>
  addStep(text, '      - name: Use the job token\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n        run: "true"'));
expectVerdict('job-token-allowed', jobToken, 0, 'Deploy secrets are SSM-only');

// /oxy/_shared/* belongs to oxy-infra (incident 2026-09-27).
const sharedPath = createFixture();
edit(sharedPath, WORKFLOW, 'shared-path-named', (text) =>
  addStep(text, '      - name: Shared\n        run: echo /oxy/_shared/REDIS_URL'));
expectVerdict('shared-path-named', sharedPath, 1, 'names a /oxy/_shared/ path outside a task-definition ARN');

// ── 3. Re-asserted bindings ────────────────────────────────────────────────
const bindingMissing = createFixture();
edit(bindingMissing, WORKFLOW, 'binding-missing', (text) =>
  text.replace(',"META_IG_BUSINESS_ACCOUNT_ID":"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/META_IG_BUSINESS_ACCOUNT_ID"', ''));
expectVerdict('binding-missing', bindingMissing, 1, 'META_IG_BUSINESS_ACCOUNT_ID is missing its exact TASK_SECRET_OVERRIDES_JSON binding');

const bindingRepointed = createFixture();
edit(bindingRepointed, WORKFLOW, 'binding-repointed', (text) =>
  text.replace(
    '"KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY":"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY"',
    '"KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY":"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/kaana/KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY"',
  ));
expectVerdict('binding-repointed', bindingRepointed, 1, 'KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY is missing its exact TASK_SECRET_OVERRIDES_JSON binding');

const bindingNotSsm = createFixture();
edit(bindingNotSsm, WORKFLOW, 'binding-not-ssm', (text) =>
  text.replace('{"SERVICE_TOKEN_PRIVATE_KEY":', '{"EXTRA":"arn:aws:secretsmanager:us-west-2:237343248947:secret:x","SERVICE_TOKEN_PRIVATE_KEY":'));
expectVerdict('binding-not-ssm', bindingNotSsm, 1, 'binds EXTRA to');

const overridesUnreadable = createFixture();
edit(overridesUnreadable, WORKFLOW, 'overrides-unparseable', (text) =>
  text.replace('{"SERVICE_TOKEN_PRIVATE_KEY":', '{SERVICE_TOKEN_PRIVATE_KEY:'));
expectVerdict('overrides-unparseable', overridesUnreadable, 1, 'TASK_SECRET_OVERRIDES_JSON is not valid JSON');

// ── 4. Every boot-required variable has a recorded home ────────────────────
const newRequired = createFixture();
edit(newRequired, ENV_MODULE, 'new-required-var-without-home', (text) =>
  text.replace("    'DATABASE_URL',\n    'ACCESS_TOKEN_SECRET',", "    'DATABASE_URL',\n    'WEBHOOK_SIGNING_SECRET',\n    'ACCESS_TOKEN_SECRET',"));
expectVerdict('new-required-var-without-home', newRequired, 1, 'WEBHOOK_SIGNING_SECRET is required at boot by validateRequiredEnvVars() but has no recorded home');

const brokenEnvParse = createFixture();
edit(brokenEnvParse, ENV_MODULE, 'unparseable-boot-contract', (text) =>
  text.replace('const required: (keyof RequiredEnvVars)[] = [', 'const requiredVars: (keyof RequiredEnvVars)[] = ['));
expectVerdict('unparseable-boot-contract', brokenEnvParse, 1, 'no longer declares');

// ── Vacuity guards, each with a case that goes GREEN without it ────────────
//
// A boot-contract regex that lands on a SHORTER array: everything it still sees
// has a home, so every other check passes. Delete MINIMUM_REQUIRED_ENV_VARS and
// this case exits 0.
const truncatedContract = createFixture();
edit(truncatedContract, ENV_MODULE, 'truncated-boot-contract', (text) =>
  text.replace(
    /const required: \(keyof RequiredEnvVars\)\[\] = \[[\s\S]*?\];/,
    "const required: (keyof RequiredEnvVars)[] = [\n    'DATABASE_URL',\n  ];",
  ));
expectVerdict('truncated-boot-contract', truncatedContract, 1, 'required env vars parsed out of');

// A regex that lands on a DIFFERENT array of the right size. Every name here
// has a home, so only the sentinel notices. Delete REQUIRED_ENV_SENTINEL and
// this case exits 0.
const wrongContractArray = createFixture();
edit(wrongContractArray, ENV_MODULE, 'wrong-boot-contract-array', (text) =>
  text.replace(
    /const required: \(keyof RequiredEnvVars\)\[\] = \[[\s\S]*?\];/,
    "const required: (keyof RequiredEnvVars)[] = [\n" +
    "    'ACCESS_TOKEN_SECRET',\n    'REFRESH_TOKEN_SECRET',\n    'DEVICE_ID_SALT',\n" +
    "    'AWS_REGION',\n    'AWS_S3_BUCKET',\n    'REDIS_URL',\n  ];",
  ));
expectVerdict('wrong-boot-contract-array', wrongContractArray, 1, 'DATABASE_URL was not among the parsed required env vars');

// A script scan that reaches nothing finds no write in it. Every script
// reference spelled some other way: delete REACHED_SCRIPT_SENTINEL and this
// case exits 0.
const nothingReached = createFixture();
edit(nothingReached, WORKFLOW, 'no-script-reached', (text) =>
  text.replace(/\.github\/scripts\/([A-Za-z0-9_.-]+)\.(sh|mjs|py)/g, './ci/$1-moved.$2'));
expectVerdict('no-script-reached', nothingReached, 1, 'deploy-ecs-image.sh was not among the scripts the deploy reaches');

for (const fixture of createdFixtures) {
  if (fixture.startsWith(fixturePrefix)) rmSync(fixture, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('Deploy secrets check tests failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Deploy secrets check discriminated ${createdFixtures.length} fixture case(s).`);
