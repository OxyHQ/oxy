#!/usr/bin/env node
/**
 * Fail the build when `packages/api/openapi.json` stops describing the API it
 * claims to describe.
 *
 * WHY A DIFF ALONE IS NOT A GATE
 *
 * `scripts/generate-openapi.ts` builds the document by walking `src/routes/`,
 * but it only walks files listed in a HAND-MAINTAINED `MOUNT_MAP`, and a file
 * absent from that map is silently skipped — a clean exit, a plausible-looking
 * document, and the routes simply not in it. Measured on `main` before this
 * gate: the whole inference surface (six route files, 42 paths, `/v1/responses`
 * and `/v1/chat/completions` among them) was missing while the DEPRECATED Alia
 * proxy was documented, and `/models/stats` was described from a route file that
 * had been deleted a fortnight earlier. Nothing anywhere failed.
 *
 * So a regenerate-and-diff layer, on its own, would have been green through all
 * of it: the committed document matched what the map produced. It stays green
 * forever if a map entry is dropped and the artifact regenerated in the SAME
 * commit, which is exactly how the defect arrived. Per `~/Oxy/AGENTS.md`: a gate
 * that skips what a hand-maintained map omits is not a gate.
 *
 * THREE LAYERS, AND NO LAYER COVERS ANOTHER
 *
 * Layer 1 — the surface is described, BY NAME. An explicit list of the paths a
 * consumer's client is generated from, checked against the committed document.
 * Not derived from the route files or from the map, because a list derived from
 * the thing under test cannot disagree with it. This is the only layer that sees
 * a map entry disappear together with its artifact.
 *
 * Layer 2 — no inference operation is published as needing no credential. This
 * is a RULE over path shape rather than a copied table: the edge and its control
 * plane are never anonymous, and the catalogue reads (`/models*`) are the one
 * deliberate exception, named here with its reason. It exists because the
 * generator infers security from middleware NAMES it recognises, so a renamed or
 * unrecognised gate makes it publish `security: [{}]` — "no credential" — which
 * is the most dangerous direction for a published contract to be wrong in.
 *
 * Layer 3 — the artifact is FRESH. Regenerate and ask git whether the committed
 * file moved. A tracked file changing IS the staleness, with no interpretation
 * needed. This is the only layer that sees a route added, removed or re-gated
 * without the document being regenerated.
 *
 * Layers 1 and 2 read the COMMITTED bytes and need no build. Layer 3 runs the
 * generator, which refuses to write unless `@oxyhq/contracts`, `@oxyhq/core` and
 * `@oxyhq/db` are built — it names them itself when they are not.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = join('packages', 'api');
const DOCUMENT = join(API_ROOT, 'openapi.json');
const GENERATOR = join(API_ROOT, 'scripts', 'generate-openapi.ts');

/**
 * The inference paths a published contract must describe, spelled out.
 *
 * These are the customer-facing surface — the OpenAI-compatible edge and the
 * model catalogue under both of the prefixes the server mounts it at. A
 * generated client (Python or otherwise) is built from exactly these, which is
 * why they are named rather than counted.
 */
const EXPECTED_PATHS = [
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/generations/{id}',
  '/v1/models',
  '/v1/models/stats',
  '/v1/models/routing-profiles',
  '/v1/models/{publisher}/{model}',
  '/models',
  '/models/stats',
  '/models/routing-profiles',
  '/models/{publisher}/{model}',
];

/**
 * The control-plane mount prefixes, each of which must describe at least one
 * path.
 *
 * A count rather than a name list, because these routes churn and a frozen list
 * of all 37 would be edited on every change without anyone reading it. What
 * cannot be allowed to happen silently is a whole route file dropping out of
 * `MOUNT_MAP`, and that takes every path under its prefix with it — which a
 * per-prefix floor of one catches and nothing else does.
 */
const EXPECTED_PREFIXES = [
  '/inference/admin/',
  '/inference/routing-policies/',
  '/inference/provider-connections/',
  '/inference/reporting/',
];

/**
 * The catalogue is genuinely reachable without a credential — an anonymous
 * caller sees the published subset, and a service token only widens it
 * (`routes/inferenceCatalogue.ts`, `viewerForRequest`). So `security: [{}]` is
 * correct there and a rule that refused it would be measuring the wrong thing.
 */
const PUBLIC_BY_DESIGN = ['/models', '/v1/models'];

/** Vacuity floors. A layer that examines nothing must fail, not pass. */
const MINIMUM_EXPECTED_PATHS = 11;
const MINIMUM_EXPECTED_PREFIXES = 4;

/** Run a command, returning stdout. Throws on a non-zero exit. */
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

/** Whether git reports the document as modified relative to HEAD. */
function documentIsDirty() {
  try {
    run('git', ['diff', '--quiet', '--', DOCUMENT]);
    return false;
  } catch {
    return true;
  }
}

function readDocument() {
  if (!existsSync(DOCUMENT)) {
    console.error(`${DOCUMENT} does not exist, so there is no published contract to check.`);
    process.exit(1);
  }
  const text = readFileSync(DOCUMENT, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error(`${DOCUMENT} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  const paths = parsed?.paths;
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
    console.error(`${DOCUMENT} has no \`paths\` object, so it describes nothing.`);
    process.exit(1);
  }
  return { document: parsed, paths };
}

/** Whether a path belongs to a prefix that is public by design. */
function isPublicByDesign(path) {
  return PUBLIC_BY_DESIGN.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The paths the credential rule applies to: the inference edge and its control
 * plane, minus the catalogue.
 */
function credentialledPaths(paths) {
  return Object.keys(paths).filter(
    (path) =>
      !isPublicByDesign(path) && (path.startsWith('/v1/') || path.startsWith('/inference/')),
  );
}

/** Layer 1: every expected path is described, by name. */
function missingExpectedPaths(paths) {
  if (EXPECTED_PATHS.length < MINIMUM_EXPECTED_PATHS) {
    console.error(
      `The expected-path list holds ${EXPECTED_PATHS.length} entr(ies), below the floor of ` +
        `${MINIMUM_EXPECTED_PATHS}. Removing an expectation is how this layer stops measuring\n` +
        'anything, so shrinking the list has to be a deliberate edit to the floor as well.',
    );
    process.exit(1);
  }
  if (EXPECTED_PREFIXES.length < MINIMUM_EXPECTED_PREFIXES) {
    console.error(
      `The expected-prefix list holds ${EXPECTED_PREFIXES.length} entr(ies), below the floor of ` +
        `${MINIMUM_EXPECTED_PREFIXES}.`,
    );
    process.exit(1);
  }

  const findings = [];
  for (const path of EXPECTED_PATHS) {
    if (!(path in paths)) findings.push(`${path} is not described at all.`);
  }
  for (const prefix of EXPECTED_PREFIXES) {
    const described = Object.keys(paths).filter((path) => path.startsWith(prefix));
    if (described.length === 0) {
      findings.push(`no path under ${prefix} is described — its route file is not being walked.`);
    }
  }
  return findings;
}

/** Layer 2: no inference operation claims it needs no credential. */
function anonymousInferenceOperations(paths) {
  const examined = credentialledPaths(paths);
  // The floor is what the by-name layer guarantees: the three edge endpoints,
  // plus at least one operation under each control-plane prefix. Below that the
  // rule matched almost nothing and its silence would mean nothing — and layer 1
  // has already failed, which is the report worth reading.
  const floor = 3 + EXPECTED_PREFIXES.length;
  if (examined.length < floor) {
    return [
      `the credential rule examined ${examined.length} path(s), below its floor of ${floor}. ` +
        'It is matching almost nothing, so its verdict carries no information.',
    ];
  }

  const findings = [];
  for (const path of examined) {
    for (const [verb, operation] of Object.entries(paths[path] ?? {})) {
      const security = operation?.security;
      if (!Array.isArray(security) || security.length === 0) {
        findings.push(
          `${verb.toUpperCase()} ${path} publishes no \`security\` at all, which a consumer reads ` +
            'as needing no credential.',
        );
        continue;
      }
      if (security.some((requirement) => Object.keys(requirement ?? {}).length === 0)) {
        findings.push(
          `${verb.toUpperCase()} ${path} offers an EMPTY security requirement, which publishes it ` +
            'as callable with no credential.',
        );
      }
    }
  }
  return findings;
}

/** The path-set delta between two documents, for a readable staleness report. */
function pathDelta(before, after) {
  const a = new Set(Object.keys(before));
  const b = new Set(Object.keys(after));
  return {
    added: [...b].filter((path) => !a.has(path)).sort(),
    removed: [...a].filter((path) => !b.has(path)).sort(),
  };
}

function reportAndExit(heading, findings, remedy) {
  console.error(
    `\n${heading}\n\n${findings.map((finding) => `  - ${finding}`).join('\n')}\n\n${remedy}\n`,
  );
  process.exit(1);
}

if (!existsSync(GENERATOR)) {
  console.error(`${GENERATOR} does not exist, so the document cannot be regenerated or compared.`);
  process.exit(1);
}

if (documentIsDirty()) {
  console.error(
    `${DOCUMENT} already has uncommitted changes, so this check cannot attribute\n` +
      'what a fresh generation would alter. Commit or revert it, then re-run.',
  );
  process.exit(1);
}

const committed = readDocument();

const missing = missingExpectedPaths(committed.paths);
if (missing.length > 0) {
  reportAndExit(
    `${DOCUMENT} does not describe the inference surface.`,
    missing,
    'Fix: add the route file to `MOUNT_MAP` in packages/api/scripts/generate-openapi.ts\n' +
      '(with the mount prefix it really has in src/server.ts), then regenerate with\n' +
      '`bun run openapi:generate` and commit the generated document in the SAME commit.\n' +
      'A file absent from that map is skipped in silence — the run exits 0 and the paths\n' +
      'are simply not in the published contract.',
  );
}

const anonymous = anonymousInferenceOperations(committed.paths);
if (anonymous.length > 0) {
  reportAndExit(
    `${DOCUMENT} publishes an inference operation as needing no credential.`,
    anonymous,
    'The generator infers security from middleware NAMES it recognises. A gate it does\n' +
      'not recognise leaves the operation looking public, which is the most dangerous\n' +
      'direction for a published contract to be wrong in.\n\n' +
      'Fix: add the gate to `MIDDLEWARE_TOKEN_RE` in\n' +
      'packages/api/scripts/generate-openapi.ts and give it a case in the security block\n' +
      'of `buildOperation`, then regenerate.',
  );
}

// The generator refuses to write a partial document and explains why on stderr —
// including the exact build sequence it needs, which is the usual cause. Catching
// here keeps that explanation as the last thing in the log instead of burying it
// under an `execFileSync` stack trace from this file.
try {
  run('bun', [GENERATOR], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch {
  console.error(
    `\n${GENERATOR} exited non-zero, so freshness could not be judged. Its own output\n` +
      'is above; a partial document is never written, so the committed contract is\n' +
      'unchanged.\n',
  );
  process.exit(1);
}

if (!documentIsDirty()) {
  console.log(
    `${DOCUMENT} is fresh, describes ${EXPECTED_PATHS.length} named inference path(s) and ` +
      `${credentialledPaths(committed.paths).length} credentialled inference operation-path(s).`,
  );
  process.exit(0);
}

const regenerated = readDocument();
const { added, removed } = pathDelta(committed.paths, regenerated.paths);
const findings = [
  ...added.map((path) => `${path} is served but NOT in the committed document.`),
  ...removed.map((path) => `${path} is in the committed document but no longer served.`),
];
if (findings.length === 0) {
  findings.push(
    'the path set is unchanged, so the drift is inside the operations — parameters, ' +
      'request bodies, security or responses. See the diff below.',
  );
}

console.error(
  `\n${DOCUMENT} is STALE.\n\n` +
    'Regenerating it changed the committed file, which means the published contract does\n' +
    `not describe the routes as they are now.\n\n${findings.map((f) => `  - ${f}`).join('\n')}\n\n` +
    'Fix: run `bun run openapi:generate` in packages/api and commit the result in the\n' +
    'SAME commit as the route change.\n',
);
console.error(run('git', ['--no-pager', 'diff', '--stat', '--', DOCUMENT]));
process.exit(1);
