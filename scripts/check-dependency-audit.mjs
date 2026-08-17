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
    package: 'deepmerge-ts',
    reachedBy: 'html-to-text -> mailparser -> @oxyhq/api (inbound email parsing)',
    reason:
      'GHSA-ggr8-5vv4-36mx is stack exhaustion while MERGING a recursive object graph, and '
      + 'nothing attacker-controlled is ever merged. mailparser calls '
      + '`htmlToText(node.textContent)` with the HTML string and NO options argument '
      + '(mailparser/lib/mail-parser.js:788), so html-to-text merges its own '
      + '`defaultOptions` with `{}` — the two arguments deepmerge-ts ever receives here are '
      + 'a fixed library literal and an empty object. The email body reaches html-to-text as '
      + 'CONTENT, which deepmerge-ts never sees. Patched in deepmerge-ts 8.0.0, which cannot '
      + 'be reached from here: html-to-text 10.0.0 is the latest release and requires ^7.1.5, '
      + 'so raising it needs a semver-major override forced into a transitive dependency. '
      + 'mailparser additionally wraps the call in try/catch and emits "Failed to parse HTML".',
  },
  {
    package: 'basic-ftp',
    reachedBy: 'get-uri -> pac-proxy-agent -> proxy-agent -> release-it (dev)',
    reason:
      'Release tooling. The vulnerable code paths are an FTP CLIENT talking to a server; '
      + 'nothing in this repository speaks FTP, and release-it reaches it only through a '
      + 'proxy-agent it never uses without a proxy configured.',
  },
  {
    package: 'shell-quote',
    reachedBy: 'react-devtools-core -> react-native (dev server)',
    reason:
      'The React Native developer tools, which run on a developer machine against a local '
      + 'Metro bundler. Not in any shipped bundle and not on the API.',
  },
  {
    package: '@hono/node-server',
    reachedBy: '@modelcontextprotocol/sdk -> shadcn (dev CLI)',
    reason:
      'A component-scaffolding CLI. Its serveStatic path-traversal advisories require running '
      + 'the Hono static server, which nothing here does — oxy-api is Express.',
  },
  {
    package: 'hono',
    reachedBy: '@modelcontextprotocol/sdk -> shadcn (dev CLI)',
    reason: 'Same dependency path as @hono/node-server. No Hono server runs in this repository.',
  },
  {
    package: '@xmldom/xmldom',
    reachedBy: '@expo/plist -> @expo/cli -> expo (build)',
    reason:
      'Expo reads and writes iOS plists at PREBUILD time from files in this repository. The '
      + 'XML-injection advisories need attacker-controlled XML, which a plist in our own tree '
      + 'is not.',
  },
  {
    package: 'brace-expansion',
    reachedBy: 'minimatch -> eslint / glob (dev)',
    reason:
      'Glob expansion in lint and build tooling, on patterns this repository authors. The DoS '
      + 'needs a hostile pattern; ours are literals in config files.',
  },
  {
    package: 'minimatch',
    reachedBy: '@eslint/config-array -> eslint, and glob (dev)',
    reason: 'Same lane and same argument as brace-expansion — author-controlled glob patterns.',
  },
  {
    package: 'picomatch',
    reachedBy: '@expo/cli -> expo (build)',
    reason: 'Same lane and same argument: build-time matching of patterns from our own config.',
  },
  {
    package: 'js-yaml',
    reachedBy: '@eslint/eslintrc -> eslint (dev)',
    reason:
      'Parses lint configuration from this repository. The quadratic-CPU advisories need a '
      + 'hostile YAML document; oxy-api parses no user YAML on any route.',
  },
  {
    package: 'flatted',
    reachedBy: 'flat-cache -> file-entry-cache -> eslint (dev)',
    reason: "ESLint's own on-disk cache, written and read by ESLint. No untrusted input.",
  },
  {
    package: 'defu',
    reachedBy: 'c12 -> release-it (dev)',
    reason:
      'Release-tool configuration merging. The prototype-pollution advisory needs an attacker '
      + "to supply the defaults object, which is release-it's own config file here.",
  },
  {
    package: 'lodash',
    reachedBy: '@nodeutils/defaults-deep -> release-it (dev)',
    reason:
      'The `_.template` code-injection advisory needs a template string from an attacker. '
      + 'release-it renders its own changelog templates, and no Oxy package depends on lodash.',
  },
  {
    package: 'undici',
    reachedBy: 'release-it (dev)',
    reason:
      "release-it's HTTP client, used to talk to GitHub and npm during a release. The advisories "
      + 'are WebSocket and multi-user proxy issues; release-it opens neither.',
  },
  {
    package: 'ws',
    reachedBy: '@react-native/dev-middleware -> @expo/cli (dev server)',
    reason:
      'The Metro dev-server websocket on a developer machine. Not shipped, and separate from '
      + "socket.io's own transport on the API.",
  },
  {
    package: 'node-forge',
    reachedBy: '@expo/cli -> expo (build)',
    reason:
      'Expo uses it for local development certificates. The signature-forgery advisories matter '
      + 'to a verifier of untrusted certificates; nothing in Oxy verifies with node-forge — '
      + '`@oxyhq/federation` and `@oxyhq/core` use Node crypto and elliptic directly.',
  },
  {
    package: 'image-size',
    reachedBy: 'metro (build)',
    reason:
      'Metro measures asset dimensions at bundle time, over images committed to this '
      + 'repository. The DoS needs a malformed image, which an attacker cannot supply to a '
      + 'build of our own tree.',
  },
  {
    package: 'postcss',
    reachedBy: '@tailwindcss/postcss (build)',
    reason:
      'CSS compilation at build time over our own stylesheets. The advisory is source-map '
      + 'auto-loading from a hostile CSS file.',
  },
  {
    package: 'rollup',
    reachedBy: '@tanstack/router-plugin -> oxy-console (build)',
    reason:
      'Bundling Console at build time. The arbitrary-file-write advisory needs a hostile module '
      + 'graph, which is our own source.',
  },
  {
    package: 'nanoid',
    reachedBy: 'expo-router (app runtime)',
    reason:
      'Runtime in the Expo apps, and the one entry here that is not dev-only tooling. The '
      + 'advisories are infinite loops when `size` is zero or negative; expo-router calls it '
      + 'with no argument, so the vulnerable input cannot occur. Nothing in Oxy generates '
      + 'security-relevant identifiers with nanoid — ids come from `@oxyhq/db` uuid v7 and '
      + 'secrets from CSPRNG bytes.',
  },
  {
    package: 'form-data',
    reachedBy: '@types/superagent -> @types/supertest (test types)',
    reason:
      'Pulled in by the supertest type packages the API and protocol suites use. The CRLF '
      + 'advisory applies to a client BUILDING a multipart body with attacker-controlled field '
      + 'names; the request paths that accept uploads on oxy-api parse multipart, they do not '
      + 'construct it.',
  },
  {
    package: 'engine.io',
    reachedBy: 'socket.io -> @oxyhq/api (runtime)',
    reason:
      'RUNTIME on the deployed API. GHSA-r635-g3xr-vw7x is polling-transport connection '
      + 'exhaustion, a resource DoS behind the ALB, and the installed 6.6.5 is one patch below '
      + 'the 6.6.7 fix, which needs socket.io to widen its `~6.6.0` range. Tracked as a '
      + 'dependency bump rather than accepted indefinitely: sockets are bearer-authenticated, '
      + 'so an anonymous flood is refused at the handshake.',
  },
  {
    package: 'socket.io-parser',
    reachedBy: 'socket.io -> @oxyhq/api, and socket.io-client -> @oxyhq/services (runtime)',
    reason:
      'RUNTIME, same lane as engine.io. Both advisories are memory exhaustion from binary '
      + 'attachments; the API emits no binary attachments and the client sends none, and the '
      + 'fix again waits on socket.io widening `~4.2.4`.',
  },
  {
    package: 'express-rate-limit',
    reachedBy: '@oxyhq/api and @oxyhq/core (runtime), plus older copies under other dependents',
    reason:
      'The API resolves 8.6.0, which is ABOVE the `>=8.2.0 <8.2.2` range of '
      + 'GHSA-46wh-pxpv-q5gq; the vulnerable 8.2.1 copy in the tree is another dependent’s. '
      + 'The advisory is an IPv4-mapped-IPv6 bypass of per-client limiting, and Oxy’s '
      + 'limiters key on a credential, an application or an HMAC of an IPv6 /56 bucket '
      + '(`hashedIpKey`) rather than on `req.ip`.',
  },
  {
    package: 'ip-address',
    reachedBy: 'express-rate-limit (runtime)',
    reason:
      'Reached only as express-rate-limit’s address parser. The advisory is leading-zero '
      + 'octet decoding, which changes which BUCKET an anonymous request lands in and cannot '
      + 'cross an authenticated key; see the express-rate-limit entry for why that is the whole '
      + 'exposure.',
  },
  {
    package: 'path-to-regexp',
    reachedBy: 'express 4 -> @oxyhq/api (runtime)',
    reason:
      'RUNTIME. The ReDoS is in compiling a ROUTE PATTERN, not in matching a request path, and '
      + 'every pattern on this API is a literal in `routes/`. Express 4 pins `~0.1.12`, so the '
      + 'fix arrives with an Express major, not from here.',
  },
  {
    package: 'fast-uri',
    reachedBy: 'ajv -> swagger-jsdoc -> @oxyhq/api (startup)',
    reason:
      'JSON-schema URI parsing inside the OpenAPI document builder, which runs at startup over '
      + 'annotations in our own source. Not on any request path.',
  },
];

/**
 * Every critical advisory, named individually. A package-level entry above is not
 * enough for a critical: the whole point of separating them is that a NEW critical
 * in an already-acknowledged package must still stop the build.
 */
const ACKNOWLEDGED_CRITICAL = [
  {
    package: 'basic-ftp',
    advisory: 'GHSA-5rq4-664w-9x2c',
    reason:
      'Path traversal in `downloadToDir()`. Requires calling that method against a hostile FTP '
      + 'server; release-it never opens an FTP connection at all.',
  },
  {
    package: 'shell-quote',
    advisory: 'GHSA-w7jw-789q-3m8p',
    reason:
      '`quote()` does not escape newlines in `.op` values. Reached only by react-devtools-core '
      + 'on a developer machine, quoting arguments it composes itself.',
  },
];

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
