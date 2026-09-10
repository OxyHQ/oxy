#!/usr/bin/env bun

/**
 * Fail the build when a dependency carries a high or critical advisory that
 * nobody has looked at.
 *
 * ## WHAT THIS REPLACES
 *
 * `.github/workflows/ci.yml` ran, under the job name "Security Audit":
 *
 *     npm audit --audit-level=high || true
 *
 * Ask the standard question — what would that report if a high-severity advisory
 * were present? Exactly what it reported with none: success. `|| true` made it
 * unconditionally green, and `ci-complete` counted it as a satisfied dependency
 * whatever it found. It also ran `npm` against a repository with no
 * `package-lock.json`, in a Bun workspace.
 *
 * ## WHY A HARD FAIL ON `bun audit` IS NOT THE FIX, MEASURED
 *
 * Run on this tree at the commit that added this file: **152 advisories across 35
 * packages — 2 critical, 74 high, 65 moderate, 11 low.** Every one is transitive.
 * The critical pair is `basic-ftp` (reached through `release-it`) and
 * `shell-quote` (reached through `react-devtools-core` inside `react-native`);
 * the high tier is dominated by the build and lint toolchain — `minimatch`,
 * `brace-expansion`, `picomatch`, `js-yaml`, `flatted`, `postcss`, `rollup`,
 * `image-size` — whose version floors are set by `eslint`, `expo`, `metro` and
 * `@tailwindcss/postcss` and cannot be raised from here.
 *
 * A gate that failed on any high advisory would therefore be red on arrival and
 * would block every unrelated pull request until 35 packages moved, most of them
 * not ours to move. That gate gets `|| true` appended within a week, which is how
 * the line above came to exist.
 *
 * ## WHAT THIS DOES INSTEAD
 *
 * A ratchet on the PACKAGE SET, plus individual acknowledgement of every
 * critical:
 *
 *   1. Any high or critical advisory in a package NOT in
 *      {@link ACKNOWLEDGED_PACKAGES} fails. That is the case that matters most —
 *      a dependency added or widened in this pull request bringing a known
 *      advisory with it — and it is the case `|| true` could never report.
 *   2. Any CRITICAL advisory not named individually in
 *      {@link ACKNOWLEDGED_CRITICAL} fails, even in an acknowledged package. A
 *      new critical is never absorbed by a package-level entry.
 *   3. An acknowledged package with no live high or critical advisory fails, and
 *      so does an acknowledged critical that is no longer reported. The list can
 *      only SHRINK, so an entry cannot outlive the advisory it excused — and a
 *      stale entry is indistinguishable from a live one until somebody audits the
 *      list, which nobody does.
 *
 * **Rule 3 is also the positive control, and it needs no extra machinery.** The
 * acknowledgement list is non-empty, so an audit that returns nothing — a network
 * failure, an endpoint change, a lockfile that resolved to nothing — turns every
 * entry stale and the run red. There is no state in which this gate reports
 * success over an audit that did not happen.
 *
 * ## THE RESIDUE, NAMED
 *
 * A NEW high advisory published against an ALREADY acknowledged package does not
 * fail this gate. That is deliberate: GitHub publishes advisories against
 * `minimatch` and `brace-expansion` on a schedule nobody here controls, and a
 * gate that reddened every open pull request on their timetable would be disabled
 * rather than obeyed. Criticals are exempt from that exemption, which is where
 * the line is drawn.
 *
 * Severities below `high` are not gated at all, only counted in the summary.
 *
 * ## HOW IT READS THE AUDIT
 *
 * `bun audit --json` writes its banner to STDERR and a JSON object to STDOUT, and
 * exits **1 whenever any advisory exists at any severity**. So the exit code is
 * not the verdict and is deliberately ignored; what matters is whether stdout
 * parsed. It needs the lockfile and the workspace manifests and NOT
 * `node_modules` — verified by running it against a tree holding only those, which
 * is why the CI job does no install.
 *
 * Usage:  bun scripts/check-dependency-audit.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Severities this gate acts on. `moderate` and `low` are reported in the summary
 * and gate nothing — 76 of this tree's 152 advisories are already at or above
 * this line, and widening it would not change what anybody can act on.
 */
const GATED_SEVERITIES = new Set(['high', 'critical']);

/**
 * Packages whose high advisories are accepted, with the path that installs them.
 *
 * `reachedBy` is from `bun why <package>` at the commit that added this file, not
 * from a guess. `reason` states why the advisory does not reach a request served
 * by `oxy-api` or a shipped app — or, where it does, why the fix is not available
 * from here.
 *
 * An entry is not permission to leave a dependency alone. It is the record that
 * somebody looked, so the next person's attention goes to what is NOT on the
 * list.
 */
const ACKNOWLEDGED_PACKAGES = [
  {
    package: 'undici',
    reachedBy: 'release-it (dev)',
    reason:
      "release-it's HTTP client, used to talk to GitHub and npm during a release. The advisories "
      + 'are WebSocket and multi-user proxy issues; release-it opens neither.',
  },
];

/**
 * Every critical advisory, named individually. A package-level entry above is not
 * enough for a critical: the whole point of separating them is that a NEW critical
 * in an already-acknowledged package must still stop the build.
 */
const ACKNOWLEDGED_CRITICAL = [];

/**
 * The fixture test synthesises every payload it feeds this gate from the REAL
 * acknowledgement lists, for the same reason the secret scanner emits its rules:
 * a fixture set that restates them proves a synthetic list matches synthetic
 * text, and stops covering the entry added next month.
 */
if (process.env.DEPENDENCY_AUDIT_EMIT_ACKNOWLEDGEMENTS === '1') {
  console.log(
    JSON.stringify({
      packages: ACKNOWLEDGED_PACKAGES.map((entry) => entry.package),
      criticals: ACKNOWLEDGED_CRITICAL.map((entry) => ({
        package: entry.package,
        advisory: entry.advisory,
      })),
    }),
  );
  process.exit(0);
}

const problems = [];

/**
 * The audit payload.
 *
 * `DEPENDENCY_AUDIT_INPUT` substitutes a file for the live call, which is what
 * lets the fixture test drive every branch offline and deterministically. It is
 * the ONLY difference between a fixture run and a CI run.
 */
function auditPayload() {
  const injected = process.env.DEPENDENCY_AUDIT_INPUT;
  if (injected !== undefined) {
    try {
      return JSON.parse(readFileSync(injected, 'utf8'));
    } catch (error) {
      console.error(`DEPENDENCY_AUDIT_INPUT (${injected}) is not readable JSON: ${error.message}`);
      process.exit(1);
    }
  }

  const audit = Bun.spawnSync({
    cmd: ['bun', 'audit', '--json'],
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // The exit code is 1 whenever ANY advisory exists, so it says nothing about
  // whether the audit succeeded. Only stdout does.
  const stdout = audit.stdout.toString().trim();
  if (stdout.length === 0) {
    console.error(
      'bun audit produced no JSON on stdout, so no advisory could be read. Treating that as a\n'
      + 'pass is the `|| true` this gate replaced: an audit that did not happen and an audit that\n'
      + 'found nothing are the same output. stderr was:\n'
      + `${audit.stderr.toString().trim() || '(empty)'}`,
    );
    process.exit(1);
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    console.error(`bun audit --json did not produce parseable JSON (${error.message}).`);
    process.exit(1);
  }
}

const payload = auditPayload();
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  console.error('The audit payload did not decode to an object of package -> advisories.');
  process.exit(1);
}

/** `{ package, advisory, severity, title }` for everything at or above the gate line. */
const gated = [];
const severityCounts = {};

for (const [packageName, advisories] of Object.entries(payload)) {
  if (!Array.isArray(advisories)) {
    problems.push(`The audit payload lists ${packageName} as something other than an array.`);
    continue;
  }
  for (const advisory of advisories) {
    const severity = typeof advisory?.severity === 'string' ? advisory.severity : 'unknown';
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
    if (!GATED_SEVERITIES.has(severity)) continue;
    // `url` is `https://github.com/advisories/GHSA-…`; the id is the last segment.
    const url = typeof advisory?.url === 'string' ? advisory.url : '';
    gated.push({
      package: packageName,
      advisory: url.split('/').pop() || `advisory-${advisory?.id ?? 'unknown'}`,
      severity,
      title: typeof advisory?.title === 'string' ? advisory.title : '(no title)',
    });
  }
}

// ── 1. Every gated advisory sits in an acknowledged package ────────────────
const acknowledgedNames = new Set(ACKNOWLEDGED_PACKAGES.map((entry) => entry.package));
const unacknowledged = gated.filter((entry) => !acknowledgedNames.has(entry.package));

for (const entry of unacknowledged) {
  problems.push(
    `${entry.package} carries a ${entry.severity} advisory nobody has acknowledged: `
    + `${entry.advisory} — ${entry.title}.`,
  );
}

// ── 2. Every critical is named individually ───────────────────────────────
const acknowledgedCritical = new Set(
  ACKNOWLEDGED_CRITICAL.map((entry) => `${entry.package} ${entry.advisory}`),
);
for (const entry of gated) {
  if (entry.severity !== 'critical') continue;
  if (acknowledgedCritical.has(`${entry.package} ${entry.advisory}`)) continue;
  problems.push(
    `${entry.package} ${entry.advisory} is CRITICAL and is not named in ACKNOWLEDGED_CRITICAL `
    + `— ${entry.title}. A package-level acknowledgement deliberately does not cover a critical.`,
  );
}

// ── 3. The lists only shrink ──────────────────────────────────────────────
const gatedPackages = new Set(gated.map((entry) => entry.package));
for (const entry of ACKNOWLEDGED_PACKAGES) {
  if (gatedPackages.has(entry.package)) continue;
  problems.push(
    `ACKNOWLEDGED_PACKAGES still excuses ${entry.package}, which no longer has any high or `
    + 'critical advisory. Delete the entry — the list has to keep describing the tree, and a '
    + 'stale entry reads exactly like a live one.',
  );
}

const gatedPairs = new Set(gated.map((entry) => `${entry.package} ${entry.advisory}`));
for (const entry of ACKNOWLEDGED_CRITICAL) {
  if (gatedPairs.has(`${entry.package} ${entry.advisory}`)) continue;
  problems.push(
    `ACKNOWLEDGED_CRITICAL still names ${entry.package} ${entry.advisory}, which the audit no `
    + 'longer reports. Delete the entry.',
  );
}

// ── Verdict ───────────────────────────────────────────────────────────────
const summary = Object.entries(severityCounts)
  .sort()
  .map(([severity, count]) => `${count} ${severity}`)
  .join(', ');

if (problems.length > 0) {
  console.error('Dependency audit FAILED:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error(
    `  Audit reported ${gated.length} advisor${gated.length === 1 ? 'y' : 'ies'} at high or above `
    + `(${summary || 'nothing'} in total).\n\n`
    + '  If a dependency you added or widened is named above: raise it past the advisory, or\n'
    + '  drop it. If it cannot be raised from here, add an ACKNOWLEDGED_PACKAGES entry stating\n'
    + '  the `bun why` path and why the advisory does not reach a served request — in the same\n'
    + '  commit as the dependency change.\n',
  );
  process.exit(1);
}

console.log(
  `Dependency audit passed — ${gated.length} advisor${gated.length === 1 ? 'y' : 'ies'} at high or `
  + `above, all inside ${ACKNOWLEDGED_PACKAGES.length} acknowledged package(s) with `
  + `${ACKNOWLEDGED_CRITICAL.length} critical(s) named individually; ${summary || 'nothing'} in total.`,
);
