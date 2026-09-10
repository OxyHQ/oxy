#!/usr/bin/env node

/**
 * Exercises check-deploy-secrets-sync.mjs against mutated copies of the REAL
 * files it guards.
 *
 * Fixtures are copies, not hand-written miniatures: a synthetic workflow would
 * drift away from `deploy-aws.yml` and start proving something about the
 * fixture instead of about the deploy. Each case copies the two real files into
 * a temp root, breaks exactly one thing, and asserts the gate goes red AND
 * names what is missing — a gate that fails without naming the variable is a
 * gate nobody can act on.
 *
 * The `both-missing` case is the one that matters most: it reproduces the
 * `DATABASE_URL` shape exactly (absent from the env block AND from both name
 * lists), which is the state that shipped and that no check anywhere reported.
 *
 * The last two cases exist to keep the gate's own vacuity guards honest: each
 * one passes (exit 0, "consistent") if its guard is deleted, so neither guard
 * can rot into decoration.
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
const ENV_MODULE = join('packages', 'api', 'src', 'config', 'env.ts');

const fixturePrefix = join(tmpdir(), 'oxy-deploy-secrets-');
const createdFixtures = [];
const failures = [];

function createFixture() {
  const root = mkdtempSync(fixturePrefix);
  createdFixtures.push(root);
  for (const relative of [WORKFLOW, ENV_MODULE]) {
    mkdirSync(join(root, dirname(relative)), { recursive: true });
    cpSync(join(repoRoot, relative), join(root, relative));
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

// The real files must pass, or nothing below means anything.
expectVerdict('unchanged', createFixture(), 0, 'Deploy secret sync is consistent');

// Half the bug: the value is exported but no list names it, so the loop never
// iterates it.
const noListEntry = createFixture();
edit(noListEntry, WORKFLOW, 'secret-not-in-any-list', (text) => text.replace(' DATABASE_URL AWS_S3_BUCKET', ' AWS_S3_BUCKET'));
expectVerdict(
  'secret-not-in-any-list',
  noListEntry,
  1,
  'DATABASE_URL has a SYNC_DATABASE_URL env entry but is in neither SHARED_SECRETS nor API_SECRETS',
);

// The other half: the name is iterated but nothing exports its value, so it is
// skipped as an empty placeholder — a warning, indistinguishable from a secret
// that legitimately has no value yet.
const noSyncEntry = createFixture();
edit(noSyncEntry, WORKFLOW, 'listed-without-sync-entry', (text) =>
  text.replace(/^\s+SYNC_DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}\n/m, ''));
expectVerdict(
  'listed-without-sync-entry',
  noSyncEntry,
  1,
  'DATABASE_URL is in API_SECRETS but has no `SYNC_DATABASE_URL',
);

// The shape that actually shipped: absent from BOTH, so the two lists agree
// with each other and only the boot contract can see the hole.
const bothMissing = createFixture();
edit(bothMissing, WORKFLOW, 'both-missing', (text) =>
  text
    .replace(/^\s+SYNC_DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}\n/m, '')
    .replace(' DATABASE_URL AWS_S3_BUCKET', ' AWS_S3_BUCKET'));
expectVerdict(
  'both-missing',
  bothMissing,
  1,
  'DATABASE_URL is required at boot by validateRequiredEnvVars() but deploy-aws.yml never syncs it to SSM.',
);

// Production-mandatory but outside the `required` array — DEVICE_ID_SALT must
// still be synced even though dev boot installs a placeholder when unset.
const deviceSaltMissing = createFixture();
edit(deviceSaltMissing, WORKFLOW, 'device-salt-not-synced', (text) =>
  text.replace(' DEVICE_ID_SALT OXY_PUBLIC_KEY', ' OXY_PUBLIC_KEY'));
expectVerdict(
  'device-salt-not-synced',
  deviceSaltMissing,
  1,
  'DEVICE_ID_SALT is production-mandatory (validateRequiredEnvVars) but deploy-aws.yml never syncs it to SSM.',
);

// A typo'd secret reference writes the WRONG value under the right SSM name —
// worse than not writing it, because nothing looks missing.
const mismatched = createFixture();
edit(mismatched, WORKFLOW, 'mismatched-secret-reference', (text) =>
  text.replace('SYNC_DATABASE_URL: ${{ secrets.DATABASE_URL }}', 'SYNC_DATABASE_URL: ${{ secrets.DATABASE_URI }}'));
expectVerdict(
  'mismatched-secret-reference',
  mismatched,
  1,
  'SYNC_DATABASE_URL reads ${{ secrets.DATABASE_URI }}',
);

// One name in both lists is written to two SSM paths, and whichever the task
// definition does not read silently rots.
const duplicated = createFixture();
edit(duplicated, WORKFLOW, 'name-in-both-lists', (text) =>
  text.replace('SHARED_SECRETS="AWS_ACCESS_KEY_ID', 'SHARED_SECRETS="DATABASE_URL AWS_ACCESS_KEY_ID'));
expectVerdict('name-in-both-lists', duplicated, 1, 'DATABASE_URL appears in both');

// The credential-control private key is provisioned directly in SSM. A
// well-formed SYNC_* entry plus matching allow-list would satisfy the generic
// parity checks, so this regression proves the SSM-only boundary independently.
const ssmOnlyCopiedFromGitHub = createFixture();
edit(ssmOnlyCopiedFromGitHub, WORKFLOW, 'ssm-only-copied-from-github', (text) =>
  text
    .replace(
      '          SYNC_KAANA_EDGE_SIGNING_PRIVATE_KEY: ${{ secrets.KAANA_EDGE_SIGNING_PRIVATE_KEY }}',
      '          SYNC_KAANA_EDGE_SIGNING_PRIVATE_KEY: ${{ secrets.KAANA_EDGE_SIGNING_PRIVATE_KEY }}\n' +
        '          SYNC_KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY: ${{ secrets.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY }}',
    )
    .replace(
      ' KAANA_EDGE_SIGNING_PRIVATE_KEY CAPABILITY_TICKET_SIGNING_PRIVATE_KEY',
      ' KAANA_EDGE_SIGNING_PRIVATE_KEY KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY CAPABILITY_TICKET_SIGNING_PRIVATE_KEY',
    ),
);
expectVerdict(
  'ssm-only-copied-from-github',
  ssmOnlyCopiedFromGitHub,
  1,
  'KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY is SSM-owned and must never be read or copied from GitHub Actions secrets',
);

// Removing the GitHub channel must not silently remove the ECS secret binding.
const ssmOnlyBindingMissing = createFixture();
edit(ssmOnlyBindingMissing, WORKFLOW, 'ssm-only-binding-missing', (text) =>
  text.replace(
    ',"KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY":"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY"',
    '',
  ),
);
expectVerdict(
  'ssm-only-binding-missing',
  ssmOnlyBindingMissing,
  1,
  'KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY is missing its exact TASK_SECRET_OVERRIDES_JSON binding',
);

// A list the gate can no longer read must be reported as such, not treated as
// an empty allowlist.
const brokenParse = createFixture();
edit(brokenParse, WORKFLOW, 'unparseable-list', (text) => text.replace(/^\s*API_SECRETS="[^"]*"\n/m, ''));
expectVerdict('unparseable-list', brokenParse, 1, 'no longer contains a API_SECRETS');

// Same, on the boot-contract side.
const brokenEnvParse = createFixture();
edit(brokenEnvParse, ENV_MODULE, 'unparseable-boot-contract', (text) =>
  text.replace('const required: (keyof RequiredEnvVars)[] = [', 'const requiredVars: (keyof RequiredEnvVars)[] = ['));
expectVerdict('unparseable-boot-contract', brokenEnvParse, 1, 'no longer declares');

// ── The two vacuity guards, each with a case that goes GREEN without it ─────
//
// A boot-contract regex that lands on a SHORTER array has no counterpart to
// contradict it: everything it still sees is synced, so every other check
// passes and the gate reports success while checking almost nothing. Here the
// array is truncated to a single (synced) name — delete MINIMUM_REQUIRED_ENV_VARS
// and this case exits 0.
const truncatedContract = createFixture();
edit(truncatedContract, ENV_MODULE, 'truncated-boot-contract', (text) =>
  text.replace(
    /const required: \(keyof RequiredEnvVars\)\[\] = \[[\s\S]*?\];/,
    "const required: (keyof RequiredEnvVars)[] = [\n    'DATABASE_URL',\n  ];",
  ));
expectVerdict('truncated-boot-contract', truncatedContract, 1, 'required env vars parsed out of');

// And a regex that lands on a DIFFERENT array of the right size is invisible to
// a count floor. Every name here is a real synced secret, so check (2) is happy;
// only the sentinel notices the gate stopped reading the boot contract. Delete
// REQUIRED_ENV_SENTINEL and this case exits 0.
const wrongContractArray = createFixture();
edit(wrongContractArray, ENV_MODULE, 'wrong-boot-contract-array', (text) =>
  text.replace(
    /const required: \(keyof RequiredEnvVars\)\[\] = \[[\s\S]*?\];/,
    "const required: (keyof RequiredEnvVars)[] = [\n" +
    "    'STRIPE_SECRET_KEY',\n    'STRIPE_WEBHOOK_SECRET',\n    'DKIM_PRIVATE_KEY',\n" +
    "    'DEVICE_ID_SALT',\n    'OXY_PUBLIC_KEY',\n    'OXY_PRIVATE_KEY',\n  ];",
  ));
expectVerdict('wrong-boot-contract-array', wrongContractArray, 1, 'DATABASE_URL was not among the parsed required env vars');

for (const fixture of createdFixtures) {
  if (fixture.startsWith(fixturePrefix)) rmSync(fixture, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('Deploy secret sync check tests failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Deploy secret sync check discriminated ${createdFixtures.length} fixture case(s).`);
