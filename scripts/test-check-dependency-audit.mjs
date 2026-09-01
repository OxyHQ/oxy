#!/usr/bin/env bun

/**
 * Mutation-tests `check-dependency-audit.mjs` against synthesised audit payloads.
 *
 * The gate's whole value is a shape it cannot reach on its own: `bun audit` on
 * this tree reports 76 advisories at high or above and every one of them is
 * acknowledged, so the LIVE run only ever exercises the passing path. Every
 * failing branch — a new package, a new critical, a stale entry, an audit that
 * returned nothing — has to be driven from a payload, and this is where they are.
 *
 * Payloads are built from the gate's own acknowledgement lists rather than from a
 * copy here, so adding an entry there is covered automatically and the clean case
 * asserts the REAL list against material shaped by the REAL list.
 *
 * No network and no install: every case substitutes a file for the live
 * `bun audit` call through `DEPENDENCY_AUDIT_INPUT`, which is the only difference
 * between a fixture run and the CI run.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gate = resolve(repositoryRoot, 'scripts/check-dependency-audit.mjs');

function acknowledgements() {
  const emitted = Bun.spawnSync({
    cmd: ['bun', gate],
    cwd: repositoryRoot,
    env: { ...process.env, DEPENDENCY_AUDIT_EMIT_ACKNOWLEDGEMENTS: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (emitted.exitCode !== 0) {
    throw new Error(`The gate would not emit its acknowledgements: ${emitted.stderr.toString()}`);
  }
  return JSON.parse(emitted.stdout.toString());
}

const { packages, criticals } = acknowledgements();

if (packages.length === 0 || criticals.length === 0) {
  console.error(
    'The gate emitted no acknowledged packages or no acknowledged criticals. Both drive every\n'
    + 'case below, and an empty set would make this file green by running nothing.',
  );
  process.exit(1);
}

const advisory = (severity, id, title) => ({
  id: 1,
  url: `https://github.com/advisories/${id}`,
  title,
  severity,
  vulnerable_versions: '<1.0.0',
});

/**
 * A payload the gate must accept: one high advisory per acknowledged package, plus
 * each acknowledged critical under its own package with its real GHSA id.
 *
 * This is also the proof that the two lists agree with each other — a critical
 * named for a package that is not acknowledged would fail rule 1 here.
 */
function cleanPayload() {
  const payload = {};
  for (const name of packages) {
    payload[name] = [advisory('high', `GHSA-synthetic-${packages.indexOf(name)}`, `${name}: a high advisory`)];
  }
  for (const entry of criticals) {
    payload[entry.package] = [
      ...(payload[entry.package] ?? []),
      advisory('critical', entry.advisory, `${entry.package}: the acknowledged critical`),
    ];
  }
  return payload;
}

async function runAgainst(payload, { raw } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oxy-dependency-audit-'));
  const inputPath = join(directory, 'audit.json');
  try {
    await writeFile(inputPath, raw ?? JSON.stringify(payload, null, 2));
    const proc = Bun.spawnSync({
      cmd: ['bun', gate],
      cwd: repositoryRoot,
      env: { ...process.env, DEPENDENCY_AUDIT_INPUT: inputPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(dirname(inputPath), { recursive: true, force: true });
  }
}

const firstPackage = packages[0];
const firstCritical = criticals[0];

const cases = [
  {
    name: 'a payload holding exactly the acknowledged advisories passes',
    payload: cleanPayload(),
    expectFailure: false,
  },

  // ------------------------------------------- 1. an unacknowledged package -----
  {
    // THE CASE THAT MATTERS MOST, and the one `npm audit … || true` could never
    // report: a dependency added or widened in a pull request that carries a
    // known advisory.
    name: 'a high advisory in a package nobody acknowledged FAILS',
    payload: {
      ...cleanPayload(),
      'some-new-dependency': [advisory('high', 'GHSA-aaaa-bbbb-cccc', 'arbitrary code execution')],
    },
    expectFailure: true,
    expectOutput: 'some-new-dependency carries a high advisory nobody has acknowledged',
  },
  {
    // The narrowness proof for the severity line. A moderate advisory in an
    // unacknowledged package must NOT fail, or every one of this tree's 65
    // moderates would need an entry and the gate would be red on arrival.
    name: 'a moderate advisory in an unacknowledged package passes',
    payload: {
      ...cleanPayload(),
      'some-new-dependency': [advisory('moderate', 'GHSA-dddd-eeee-ffff', 'a moderate issue')],
    },
    expectFailure: false,
  },

  // -------------------------------------------------- 2. criticals by name ------
  {
    // A package-level acknowledgement deliberately does NOT absorb a new
    // critical. Without this the residue the gate accepts (a new HIGH in an
    // acknowledged package) would silently extend to criticals too.
    name: 'a NEW critical inside an acknowledged package FAILS',
    payload: (() => {
      const payload = cleanPayload();
      payload[firstPackage] = [
        ...payload[firstPackage],
        advisory('critical', 'GHSA-9999-9999-9999', 'a critical nobody has seen'),
      ];
      return payload;
    })(),
    expectFailure: true,
    expectOutput: 'is not named in ACKNOWLEDGED_CRITICAL',
  },

  // ------------------------------------------------ 3. the shrink discipline ----
  {
    name: 'an acknowledged package with no live advisory FAILS as stale',
    payload: (() => {
      const payload = cleanPayload();
      delete payload[firstPackage];
      return payload;
    })(),
    expectFailure: true,
    expectOutput: `still excuses ${firstPackage}`,
  },
  {
    name: 'an acknowledged critical the audit no longer reports FAILS as stale',
    payload: (() => {
      const payload = cleanPayload();
      payload[firstCritical.package] = payload[firstCritical.package].filter(
        (entry) => !entry.url.endsWith(firstCritical.advisory),
      );
      return payload;
    })(),
    expectFailure: true,
    expectOutput: `still names ${firstCritical.package} ${firstCritical.advisory}`,
  },
  {
    // The severity line applied to staleness: an acknowledged package whose only
    // remaining advisory is moderate is FIXED as far as this gate is concerned,
    // and its entry has to go. Without this, an entry would outlive its advisory
    // whenever a severity was downgraded.
    name: 'an acknowledged package left with only a moderate advisory FAILS as stale',
    payload: (() => {
      const payload = cleanPayload();
      payload[firstPackage] = [advisory('moderate', 'GHSA-1111-2222-3333', 'downgraded')];
      return payload;
    })(),
    expectFailure: true,
    expectOutput: `still excuses ${firstPackage}`,
  },

  // ------------------------------------------------ the vacuity floor -----------
  {
    // THE POSITIVE CONTROL, and the reason this gate needs no separate one. An
    // audit that returned nothing — a network failure, a changed endpoint, a
    // lockfile that resolved to nothing — is indistinguishable from a clean tree
    // by inspection of the payload alone. With a non-empty acknowledgement list,
    // it turns every entry stale and the run red.
    name: 'an empty audit payload FAILS rather than reading as a clean tree',
    payload: {},
    expectFailure: true,
    expectOutput: 'no longer has any high or critical advisory',
  },
  {
    name: 'an unparseable payload FAILS',
    payload: {},
    raw: 'not json at all',
    expectFailure: true,
    expectOutput: 'not readable JSON',
  },
  {
    name: 'a payload that is not an object of arrays FAILS',
    payload: {},
    raw: JSON.stringify([{ package: 'x' }]),
    expectFailure: true,
    expectOutput: 'did not decode to an object',
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.payload, { raw: testCase.raw });
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
  console.log(`ok   ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} dependency-audit cases failed.`);
  process.exit(1);
}
console.log(
  `\nAll ${cases.length} dependency-audit cases passed — ${packages.length} acknowledged packages `
  + `and ${criticals.length} acknowledged criticals, taken from the gate itself.`,
);
