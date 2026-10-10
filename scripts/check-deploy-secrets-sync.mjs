#!/usr/bin/env node
/**
 * Fail the build when the API deploy starts copying secrets into SSM again, or
 * reads a runtime secret out of GitHub.
 *
 * THE STANDARD
 *
 * Runtime secrets of oxy-api live ONLY in SSM Parameter Store: `/oxy/oxy-api/*`
 * (SecureString) and the oxy-infra-owned `/oxy/_shared/*`. The ECS task
 * definition reads them at task start. Setting or rotating one is
 * `aws ssm put-parameter --overwrite` by its owner (oxy-infra
 * docs/runbooks/46-app-secrets-in-ssm.md), never a repo secret and never a
 * workflow.
 *
 * Until 2026-10-10 `.github/workflows/deploy-aws.yml` copied an allowlist of
 * GitHub repo secrets into `/oxy/oxy-api/*` on every deploy, and this gate held
 * that allowlist consistent. That made GitHub the source of truth for the
 * identity API's production credentials: whoever could edit a repo secret
 * changed what production ran with, every value lived in two systems, and a
 * placeholder synced over a real value took the API down (2026-06-12). Before
 * that, several app deploys each wrote their own GitHub copy into
 * `/oxy/_shared/REDIS_URL` and flipped it between clusters (2026-09-27).
 *
 * WHAT IS CHECKED
 *
 *   1. Nothing the deploy runs writes or deletes an SSM parameter: no
 *      executable line of the workflow, nor of any `.github/scripts/*` file it
 *      reaches (followed transitively), names `put-parameter`,
 *      `delete-parameter` or `put-secure-parameter.sh`.
 *   2. The workflow reads no repo secret except the CI-only allowlist below,
 *      never the whole `secrets` context (`toJSON(secrets)`, `secrets[...]`,
 *      `secrets: inherit`), and names no `/oxy/_shared/` path except as a
 *      task-definition ARN (a READ).
 *   3. Every secret binding the deploy re-asserts (TASK_SECRET_OVERRIDES_JSON)
 *      is present with its exact SSM ARN, and every entry there is an SSM ARN
 *      in this account and region.
 *   4. Every environment variable `validateRequiredEnvVars()` requires at boot
 *      (`packages/api/src/config/env.ts`) has a recorded home: an SSM-owned
 *      secret, an oxy-infra-owned shared parameter, or plain task-definition
 *      environment with the reason it is not a secret. A new required variable
 *      forces that decision on the pull request instead of surfacing as a task
 *      that cannot start.
 *
 * WHAT IS NOT CHECKED, DELIBERATELY
 *
 * Whether each parameter EXISTS in SSM, and whether the task definition's
 * inherited bindings reference it. Both live in AWS and in oxy-infra, and
 * reaching AWS from a PR check would hand pull requests deploy credentials.
 *
 * Paths are resolved from the working directory, so the fixture tests in
 * `scripts/test-check-deploy-secrets-sync.mjs` can run it against a mutated
 * copy of the real files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_PATH = join('.github', 'workflows', 'deploy-aws.yml');
const SCRIPTS_DIR = join('.github', 'scripts');
const ENV_MODULE_PATH = join('packages', 'api', 'src', 'config', 'env.ts');

const SSM_ARN_PREFIX = 'arn:aws:ssm:us-west-2:237343248947:parameter';

/**
 * Repo secrets this workflow may read: only what CI itself spends. Today the
 * deploy reads none (it uses `github.token`); GITHUB_TOKEN is the one name it
 * may spell as a secret.
 */
const CI_ONLY_SECRETS = new Set(['GITHUB_TOKEN']);

/** An executable mention of any of these is an SSM write or delete. */
const SSM_MUTATION = /put-parameter|delete-parameter|put-secure-parameter\.sh/;

/**
 * Required env vars that are NOT secrets, with the reason. They are plain
 * environment in the ECS task definition (oxy-infra terraform-uswest2).
 */
const SUPPLIED_AS_PLAIN_ENV = new Map([
  ['AWS_REGION', 'a region string, not a secret'],
  ['AWS_S3_BUCKET', 'a bucket name, not a secret'],
]);

/**
 * `/oxy/_shared/*` parameters the API reads. oxy-infra owns them, not any app,
 * and rotates them once, centrally (oxy-infra
 * docs/runbooks/45-shared-ssm-parameters.md).
 */
const INFRA_OWNED_SHARED_SECRETS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'REDIS_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
];

/**
 * Boot-required secrets and their SSM home. The task definition binds each one
 * (inherited from the running revision); the parameter is written by its owner.
 * DEVICE_ID_SALT is validated outside the `required` array (dev installs a
 * placeholder) but production boot fails without it.
 */
const SSM_OWNED_BOOT_SECRETS = new Map([
  ['DATABASE_URL', '/oxy/oxy-api/DATABASE_URL'],
  ['ACCESS_TOKEN_SECRET', '/oxy/oxy-api/ACCESS_TOKEN_SECRET'],
  ['REFRESH_TOKEN_SECRET', '/oxy/oxy-api/REFRESH_TOKEN_SECRET'],
  ['DEVICE_ID_SALT', '/oxy/oxy-api/DEVICE_ID_SALT'],
]);
const PRODUCTION_MANDATORY_SECRETS = ['DEVICE_ID_SALT'];

/**
 * The bindings the deploy re-asserts on every rollout, because it renders from
 * the RUNNING task definition rather than Terraform's latest revision. Kept as
 * an exact expectation, not derived from the workflow: the failure this guards
 * is a binding silently dropping out, and deriving the list would hide it.
 */
const EXPECTED_TASK_SECRET_BINDINGS = new Map(
  [
    ['SERVICE_TOKEN_PRIVATE_KEY', '/oxy/oxy-api/SERVICE_TOKEN_PRIVATE_KEY'],
    ['SERVICE_TOKEN_SIGNING_KEY_ID', '/oxy/oxy-api/SERVICE_TOKEN_SIGNING_KEY_ID'],
    ['CAPABILITY_TICKET_SIGNING_PRIVATE_KEY', '/oxy/oxy-api/CAPABILITY_TICKET_SIGNING_PRIVATE_KEY'],
    ['CAPABILITY_TICKET_SIGNING_KEY_ID', '/oxy/oxy-api/CAPABILITY_TICKET_SIGNING_KEY_ID'],
    ['KAANA_EDGE_SIGNING_PRIVATE_KEY', '/oxy/oxy-api/KAANA_EDGE_SIGNING_PRIVATE_KEY'],
    [
      'KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY',
      '/oxy/oxy-api/KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY',
    ],
    ['INBOX_APPLICATION_KEY', '/oxy/inbox/OXY_APPLICATION_KEY'],
    ['INBOX_APPLICATION_SECRET', '/oxy/inbox/OXY_APPLICATION_SECRET'],
    ['QUEUE_REDIS_URL', '/oxy/_shared/QUEUE_REDIS_URL'],
    ['META_GRAPH_ACCESS_TOKEN', '/oxy/oxy-api/META_GRAPH_ACCESS_TOKEN'],
    ['META_IG_BUSINESS_ACCOUNT_ID', '/oxy/oxy-api/META_IG_BUSINESS_ACCOUNT_ID'],
  ].map(([name, path]) => [name, `${SSM_ARN_PREFIX}${path}`]),
);

/**
 * Vacuity guards. Each parse below can degrade into reading LESS than it should
 * and then report "0 problems"; each guard is covered by a fixture case in
 * `test-check-deploy-secrets-sync.mjs` that goes green if it is deleted.
 */
const MINIMUM_REQUIRED_ENV_VARS = 5;
// `DATABASE_URL`, not `MONGODB_URI`: the sentinel has to be a name that will
// still be in the required array. MONGODB_URI left the serving path on
// 2026-08-02 and is no longer bound into ECS — only backfill/admin scripts read
// it locally — so the sentinel moved rather than being dropped.
const REQUIRED_ENV_SENTINEL = 'DATABASE_URL';
// The script that performs every rollout. If the scan of reached scripts does
// not see it, the scan is not reading what the deploy runs.
const REACHED_SCRIPT_SENTINEL = 'deploy-ecs-image.sh';

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

/**
 * Lines that execute: a whole-line comment does not. `#` for YAML, shell and
 * Python; `//`, `/*` and ` *` for JavaScript (a shell `*)` case arm is code).
 */
function executableLines(text, path = '') {
  const comment = /\.m?js$/.test(path) ? /^\s*(\/\/|\/\*|\*(?!\)))/ : /^\s*#/;
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !comment.test(line));
}

/** `.github/scripts/<name>` and bare `<name>.sh|.mjs|.py` tokens that exist there. */
function referencedScripts(text, path = '') {
  const names = new Set();
  for (const { line } of executableLines(text, path)) {
    for (const match of line.matchAll(
      /(?:\.github\/scripts\/)?([A-Za-z0-9_.-]+\.(?:sh|mjs|js|py))\b/g,
    )) {
      if (existsSync(join(SCRIPTS_DIR, match[1]))) names.add(match[1]);
    }
  }
  return names;
}

/** The names in `validateRequiredEnvVars()`'s `required` array. */
function parseRequiredEnvVars(envModule) {
  const block = envModule.match(
    /const required:\s*\(keyof RequiredEnvVars\)\[\]\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!block) {
    fail(
      `${ENV_MODULE_PATH} no longer declares \`const required: (keyof RequiredEnvVars)[] = [...]\`; the gate cannot read the boot contract.`,
    );
    return [];
  }
  return [...block[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((match) => match[1]);
}

/** TASK_SECRET_OVERRIDES_JSON's folded value, parsed. */
function parseTaskSecretOverrides(workflow) {
  const match = workflow.match(/^\s*TASK_SECRET_OVERRIDES_JSON:\s*>-\s*\n\s*(\{.*\})\s*$/m);
  if (!match) {
    fail(
      'deploy-aws.yml no longer contains a one-line `TASK_SECRET_OVERRIDES_JSON: >-` object; the gate cannot read the re-asserted bindings.',
    );
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    fail(`deploy-aws.yml TASK_SECRET_OVERRIDES_JSON is not valid JSON: ${error.message}`);
    return null;
  }
}

const workflow = read(WORKFLOW_PATH);
const envModule = read(ENV_MODULE_PATH);

// ── 1. Nothing the deploy runs writes or deletes an SSM parameter ──────────
for (const { line, number } of executableLines(workflow)) {
  if (SSM_MUTATION.test(line)) {
    fail(
      `deploy-aws.yml:${number} writes or deletes an SSM parameter (${line.trim()}). Runtime secrets live ONLY in SSM ` +
        'and are set by their owner with `aws ssm put-parameter --overwrite`; the deploy never writes one.',
    );
  }
}
const reached = new Set();
const queue = [...referencedScripts(workflow)];
while (queue.length > 0) {
  const name = queue.shift();
  if (reached.has(name)) continue;
  reached.add(name);
  const text = read(join(SCRIPTS_DIR, name));
  for (const { line, number } of executableLines(text, name)) {
    if (SSM_MUTATION.test(line)) {
      fail(
        `.github/scripts/${name}:${number}, which the deploy runs, writes or deletes an SSM parameter (${line.trim()}).`,
      );
    }
  }
  for (const next of referencedScripts(text, name)) queue.push(next);
}
if (!reached.has(REACHED_SCRIPT_SENTINEL)) {
  fail(
    `${REACHED_SCRIPT_SENTINEL} was not among the scripts the deploy reaches — the scan is not reading what the deploy runs.`,
  );
}

// ── 2. No repo secret but the CI-only allowlist, never the whole context ───
for (const { line, number } of executableLines(workflow)) {
  if (/^\s*secrets:\s*inherit\b/.test(line)) {
    fail(
      `deploy-aws.yml:${number} passes \`secrets: inherit\`; that hands every repo secret to the callee.`,
    );
  }
}
for (const expression of workflow.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
  const body = expression[1];
  if (/toJSON\s*\(\s*secrets\s*\)/.test(body)) {
    fail('deploy-aws.yml reads `toJSON(secrets)`, the whole secrets context.');
    continue;
  }
  for (const use of body.matchAll(/\bsecrets\b(\s*\.\s*([A-Za-z0-9_]+)|\s*\[)?/g)) {
    const name = use[2];
    if (!name) {
      fail(`deploy-aws.yml reads the secrets context without a literal name (\`${body.trim()}\`).`);
    } else if (!CI_ONLY_SECRETS.has(name)) {
      fail(
        `deploy-aws.yml reads secrets.${name}. Runtime secrets live ONLY in SSM (/oxy/oxy-api/${name}), bound by the task ` +
          `definition; the deploy reads no repo secret but ${[...CI_ONLY_SECRETS].join(', ')}.`,
      );
    }
  }
}
// A task-definition ARN (`...:parameter/oxy/_shared/NAME`) is a READ and is
// fine; any other executable mention of the path is a candidate write.
for (const { line, number } of executableLines(workflow)) {
  if (/(?<!parameter)\/oxy\/_shared\//.test(line)) {
    fail(
      `deploy-aws.yml:${number} names a /oxy/_shared/ path outside a task-definition ARN; app deploys never write shared parameters, which oxy-infra owns.`,
    );
  }
}

// ── 3. Re-asserted bindings: exact, and SSM only ──────────────────────────
const overrides = parseTaskSecretOverrides(workflow);
if (overrides) {
  for (const [name, arn] of EXPECTED_TASK_SECRET_BINDINGS) {
    if (overrides[name] !== arn) {
      fail(
        `${name} is missing its exact TASK_SECRET_OVERRIDES_JSON binding to ${arn} (found ${JSON.stringify(overrides[name] ?? null)}).`,
      );
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value !== 'string' || !value.startsWith(`${SSM_ARN_PREFIX}/oxy/`)) {
      fail(
        `TASK_SECRET_OVERRIDES_JSON binds ${name} to ${JSON.stringify(value)}, which is not an SSM parameter under ${SSM_ARN_PREFIX}/oxy/.`,
      );
    }
  }
}

// ── 4. Every boot-required variable has a recorded home ───────────────────
const requiredEnvVars = parseRequiredEnvVars(envModule);
if (requiredEnvVars.length > 0 && requiredEnvVars.length < MINIMUM_REQUIRED_ENV_VARS) {
  fail(
    `Only ${requiredEnvVars.length} required env vars parsed out of ${ENV_MODULE_PATH} (expected at least ${MINIMUM_REQUIRED_ENV_VARS}). The parse is broken, not the source.`,
  );
}
if (requiredEnvVars.length > 0 && !requiredEnvVars.includes(REQUIRED_ENV_SENTINEL)) {
  fail(
    `${REQUIRED_ENV_SENTINEL} was not among the parsed required env vars — the gate is reading the wrong array in ${ENV_MODULE_PATH}.`,
  );
}
for (const name of [...requiredEnvVars, ...PRODUCTION_MANDATORY_SECRETS]) {
  if (SSM_OWNED_BOOT_SECRETS.has(name)) continue;
  if (SUPPLIED_AS_PLAIN_ENV.has(name)) continue;
  if (INFRA_OWNED_SHARED_SECRETS.includes(name)) continue;
  fail(
    `${name} is required at boot by validateRequiredEnvVars() but has no recorded home. If it is a secret, write ` +
      `/oxy/oxy-api/${name} (SecureString) with \`aws ssm put-parameter\` FIRST, bind it in the task definition, and record ` +
      'it in SSM_OWNED_BOOT_SECRETS in scripts/check-deploy-secrets-sync.mjs; if it is not, record why in SUPPLIED_AS_PLAIN_ENV.',
  );
}

if (problems.length > 0) {
  console.error('Deploy secrets are BROKEN:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    '\nRuntime secrets live ONLY in SSM /oxy/oxy-api/* (oxy-infra docs/runbooks/46-app-secrets-in-ssm.md);' +
      '\nthe deploy reads them through the task definition and writes none.',
  );
  process.exit(1);
}

console.log(
  `Deploy secrets are SSM-only: no SSM write in deploy-aws.yml or the ${reached.size} scripts it reaches, ` +
    `no repo secret read but ${[...CI_ONLY_SECRETS].join(', ')}, ` +
    `all ${EXPECTED_TASK_SECRET_BINDINGS.size} re-asserted bindings exact, ` +
    `and all ${requiredEnvVars.length} boot-required env vars have a recorded home.`,
);
