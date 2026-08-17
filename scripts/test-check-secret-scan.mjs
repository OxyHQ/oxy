#!/usr/bin/env bun

/**
 * Mutation-tests `check-secret-scan.mjs` against fixture repositories.
 *
 * A secret scanner that has only ever been seen to pass is indistinguishable
 * from one that cannot fail, and every part of this one fails QUIET: a typo in a
 * regex prints a clean zero, a widened placeholder predicate excuses everything,
 * a broken `git ls-files` reports an empty tree, and a NUL byte makes a token
 * that is right there read as absent.
 *
 * THE RULE SET AND THE ALLOW-LIST COME FROM THE GATE ITSELF, not from a copy
 * here. The gate emits both on request, and this file builds one planted-secret
 * case per rule and one fixture file per allow-list entry from what it emits. So
 * a rule added to the gate gets a case automatically, and the clean-tree case
 * asserts the REAL allow-list's exact counts against material shaped by the REAL
 * rules — a restated list would only prove that a synthetic list matches
 * synthetic text.
 *
 * The cases that must PASS carry the weight. This tree deliberately holds
 * placeholder credentials (`AKIAEXAMPLENOTREAL00`, `sk-live-4f9c2a7b1e6d8f3a5c0b`,
 * two short PEM blocks 71 lines apart in one doc) and a scanner that fired on
 * them would be turned off by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the gate's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gate = resolve(repositoryRoot, 'scripts/check-secret-scan.mjs');

/** The gate's own rule set and allow-list — see the header. */
function emittedConfiguration() {
  const emitted = Bun.spawnSync({
    cmd: ['bun', gate],
    cwd: repositoryRoot,
    env: { ...process.env, SECRET_SCAN_EMIT_RULES: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (emitted.exitCode !== 0) {
    throw new Error(`The gate would not emit its rules: ${emitted.stderr.toString()}`);
  }
  return JSON.parse(emitted.stdout.toString());
}

const { rules, allowed } = emittedConfiguration();

if (rules.length === 0 || allowed.length === 0) {
  // Both drive every case below. An empty set would make the whole file green by
  // running nothing, which is the failure this file exists to refuse elsewhere.
  console.error('The gate emitted no rules or no allow-list entries; there is nothing to test.');
  process.exit(1);
}

async function runAgainst(files, { realFloors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oxy-secret-scan-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    // `-f` because a developer's global excludes file can legitimately ignore a
    // path a fixture depends on — `.env` above all, which is the one path this
    // gate must see in the INDEX.
    Bun.spawnSync({ cmd: ['git', '-c', 'init.defaultBranch=main', 'init', '-q'], cwd: root });
    Bun.spawnSync({ cmd: ['git', 'add', '-A', '-f'], cwd: root });

    const environment = { ...process.env, SECRET_SCAN_ROOT: root };
    if (!realFloors) environment.SECRET_SCAN_FIXTURE_FLOORS = '1';

    const proc = Bun.spawnSync({
      cmd: ['bun', gate],
      cwd: repositoryRoot,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const sampleFor = (name) => {
  const rule = rules.find((entry) => entry.name === name);
  if (rule === undefined) throw new Error(`The gate has no rule named ${name}`);
  return rule.sample;
};

/**
 * A real NUL byte, built from its code point rather than typed inline.
 *
 * The binary-file case below is the ONLY one whose value depends on the byte
 * actually being there, and a NUL is invisible in every editor and diff — so a
 * fixture that lost it would still pass, for the wrong reason, while no longer
 * testing the blind spot it exists for.
 */
const NUL = String.fromCharCode(0);

/**
 * A tree that is clean on this gate.
 *
 * It carries one file per allow-list entry, holding exactly the declared number
 * of matches for exactly the declared rule — so the clean case is also the proof
 * that every entry describes real, findable material and that its count is exact.
 * Forgetting an entry turns every case below red with a message naming it.
 *
 * THE COUPLING IS DELIBERATE, the same way the flat-account-list guard couples
 * its filler to `KNOWN_EXCEPTIONS`.
 */
function filler(extra = {}) {
  const files = {
    'package.json': `${JSON.stringify({ name: 'secret-scan-fixture', private: true }, null, 2)}\n`,
    'README.md': 'A fixture tree. No issued credential material of any kind.\n',
    'src/config.ts': "export const apiBase = 'https://api.oxy.so';\n",
  };
  for (const entry of allowed) {
    const body = Array.from({ length: entry.occurrences }, () => sampleFor(entry.rule)).join('\n\n');
    files[entry.file] = `${body}\n`;
  }
  return { ...files, ...extra };
}

/** The first allow-listed (file, rule) pair — the subject of the allow-list cases. */
const [firstAllowed] = allowed;

const cases = [
  {
    name: 'a tree with no issued credential material passes',
    files: filler(),
    expectFailure: false,
  },

  // ---------------------------------------------- one case per live rule -------
  // Built from the gate's own rules, so this coverage cannot fall behind them.
  ...rules.map((rule) => ({
    name: `${rule.name} is detected`,
    files: filler({
      // A path with no test/fixture/example segment, so nothing about the
      // LOCATION could be what excuses or accuses it.
      'packages/api/src/services/upstream.ts': `const credential = \`${rule.sample}\`;\nexport default credential;\n`,
    }),
    expectFailure: true,
    expectOutput: rule.name,
  })),

  {
    // The redaction contract. The whole reason the gate prints a length instead
    // of the match is that a CI log outlives the commit being rewritten, and a
    // log is readable by everyone with access to the run.
    name: 'a finding never prints the matched material',
    files: filler({
      'packages/api/src/services/upstream.ts': `const credential = '${sampleFor('aws-access-key-id')}';\n`,
    }),
    expectFailure: true,
    expectOutput: 'redacted',
    expectNotOutput: sampleFor('aws-access-key-id'),
  },

  // ------------------------------------------------------- the dotenv rule -----
  {
    name: 'a tracked .env file is refused on its path alone',
    files: filler({ '.env': 'DATABASE_URL=postgres://user@host/db\n' }),
    expectFailure: true,
    expectOutput: 'tracked-dotenv-file',
  },
  {
    name: 'a tracked .env in a package is refused too',
    // The file this rule exists for: `packages/api/.env` was once committed with
    // live JWT secrets in it.
    files: filler({ 'packages/api/.env': 'ACCESS_TOKEN_SECRET=not-going-to-say\n' }),
    expectFailure: true,
    expectOutput: 'tracked-dotenv-file',
  },
  {
    // THE NARROWNESS PROOF for the dotenv rule. Four `.env.example` files are
    // tracked here and are where the KEYS are supposed to be documented; a gate
    // that refused them would be refusing the correct practice.
    name: '.env.example, .env.sample and .env.template pass',
    files: filler({
      '.env.example': 'DATABASE_URL=\n',
      'packages/api/.env.sample': 'ACCESS_TOKEN_SECRET=\n',
      'packages/console/.env.template': 'VITE_OXY_CLIENT_ID=\n',
    }),
    expectFailure: false,
  },

  // ------------------------------------ the placeholder and length narrowness ---
  {
    // Verbatim from `packages/contracts/src/__tests__/inference.errors.test.ts`.
    // An AWS key id is a FIXED twenty characters, so no length floor separates
    // this from a real one — the placeholder predicate is the only thing that
    // does, which is why it exists.
    name: 'a placeholder-marked AWS key id in a contracts test does NOT fire',
    files: filler({
      'packages/contracts/src/__tests__/inference.errors.test.ts':
        "const message = 'AKIAEXAMPLENOTREAL00 is not authorized to invoke this model';\n",
    }),
    expectFailure: false,
  },
  {
    // THE DEAD-BRANCH PIN, from review of PR #1029. A Stripe test-mode key spells
    // `test` in its own GRAMMAR, so a placeholder predicate applied to every rule
    // excused every one of them and the `_test_` half of that rule could never
    // report anything — while the rule's `sk_live_` sample kept the in-run control
    // green, because a rule can be half-inert and still match one sample. The key
    // is derived from the gate's own sample, so no Stripe-shaped literal is
    // committed here for the scanner to find in its own test.
    name: 'a Stripe TEST-mode key is reported, not excused as a placeholder',
    files: filler({
      'packages/api/src/services/billing.ts':
        `const key = '${sampleFor('stripe-key').replace('_live_', '_test_')}';\n`,
    }),
    expectFailure: true,
    expectOutput: 'stripe-key',
  },
  {
    // The other half, and the reason `sk-` has a 40-character floor: this string
    // appears eight times in this tree as a deliberate fixture, and it is 25
    // characters after the prefix where a real key is 48.
    name: "the tree's short sk- fixtures do NOT fire",
    files: filler({
      'packages/contracts/src/__tests__/inference.providerConnection.test.ts':
        "const rejected = [{ apiKey: 'sk-live-4f9c2a7b1e6d8f3a5c0b' }, { secret: 'sk-live-4f9c2a7b1e6d8f3a5c0b' }];\n",
    }),
    expectFailure: false,
  },
  {
    // THE TEMPERED-BODY PROOF. `docs/EMAIL.md` holds two PEM placeholders 71
    // lines apart. Without the `(?!-----)` temper, the body length floor is met
    // by the prose BETWEEN them and the gate reports a leak that is not there —
    // and it reports it in a doc, where a reader has no way to tell.
    name: 'two short PEM placeholders in one file do NOT fire',
    files: filler({
      'docs/EMAIL.md':
        'DKIM_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nYOUR_KEY_HERE\\n-----END RSA PRIVATE KEY-----"\n'
        + `${'Prose about how DKIM signing works.\n'.repeat(70)}`
        + 'DKIM_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAK...\\n-----END RSA PRIVATE KEY-----"\n',
    }),
    expectFailure: false,
  },
  {
    // The PUBLIC identifier. `oxy_dk_…` IS the OAuth `client_id`: it ships inside
    // mobile bundles and an unauthenticated route serves it, so it appears
    // legitimately in eleven places here. A rule for it would have been reverted
    // the first time anyone touched an app config.
    name: 'the public oxy_dk_ client id does NOT fire',
    files: filler({
      'packages/console/src/lib/config.ts':
        "export const clientId = 'oxy_dk_0123456789abcdef0123456789abcdef0123456789ab';\n",
    }),
    expectFailure: false,
  },

  // ------------------------------------------------ the NUL-byte blind spot -----
  {
    // A token inside a file holding a NUL byte. Anything that treats such a file
    // as binary and skips it leaves a blind spot for free, and the token is
    // present and readable — this fixture is exactly what a leak inside a
    // compiled artifact or a font-adjacent blob looks like.
    name: 'a token inside a file with a NUL byte is still found',
    files: filler({
      'packages/services/assets/blob.bin': NUL + 'binary preamble ' + sampleFor('github-token') + ' tail' + NUL,
    }),
    expectFailure: true,
    expectOutput: 'github-token',
  },

  // ------------------------------------------------------- the allow-list -------
  {
    // The shrink discipline. A tree where the excused material no longer exists
    // must FAIL, so an exception cannot outlive the thing it worked around — a
    // stale entry is indistinguishable from a live one until somebody audits the
    // list, and nobody audits the list.
    name: 'an allow-list entry that matches nothing FAILS the run',
    files: (() => {
      const files = filler();
      delete files[firstAllowed.file];
      return files;
    })(),
    expectFailure: true,
    expectOutput: 'no longer matches anything',
  },
  {
    // THE EXACT-COUNT PROOF, and the reason entries carry a number rather than a
    // boolean. An entry saying "this file has findings" would excuse a second,
    // real key added beside the excused one.
    name: 'one more finding than the entry excuses FAILS the run',
    files: (() => {
      const files = filler();
      files[firstAllowed.file] += `\n${sampleFor(firstAllowed.rule)}\n`;
      return files;
    })(),
    expectFailure: true,
    expectOutput: 'A count that has grown',
  },
  {
    // The other axis of the same key: the entry excuses ONE rule in that file, so
    // a different rule matching in the same file is still a finding.
    name: 'an excused file still fails on a rule the entry does not cover',
    files: (() => {
      const files = filler();
      const other = rules.find((rule) => rule.name !== firstAllowed.rule);
      files[firstAllowed.file] += `\nconst leaked = '${other.sample}';\n`;
      return files;
    })(),
    expectFailure: true,
    expectOutput: rules.find((rule) => rule.name !== firstAllowed.rule).name,
  },

  // ------------------------------------------------------ the vacuity floors ----
  {
    // A tree of five files, judged by the real floors — the shape a broken
    // `git ls-files` produces, and the one that reports a clean scan.
    name: 'a listing that found almost nothing cannot pass silently',
    files: filler(),
    realFloors: true,
    expectFailure: true,
    expectOutput: 'below the 2500 floor',
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files, {
    realFloors: testCase.realFloors === true,
  });
  const didFail = exitCode !== 0;

  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? 'a failure' : 'a pass'}, `
      + `got exit ${exitCode}\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    console.error(
      `FAIL ${testCase.name}: failed as expected, but the message never said `
      + `"${testCase.expectOutput}"\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectNotOutput && output.includes(testCase.expectNotOutput)) {
    console.error(
      `FAIL ${testCase.name}: the output contained material it must never print.\n${output}`,
    );
    failed += 1;
    continue;
  }
  console.log(`ok   ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} secret-scan cases failed.`);
  process.exit(1);
}
console.log(
  `\nAll ${cases.length} secret-scan cases passed — ${rules.length} rules and `
  + `${allowed.length} allow-list entries, taken from the gate itself.`,
);
