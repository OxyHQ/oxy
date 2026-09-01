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
 * Layer 3 — the named `/v1` operations DESCRIBE THEIR PAYLOADS. A request body on
 * the ones that take one, a success schema on all of them, and no `{}` standing in
 * for a schema. Layers 1 and 2 can only see whether an operation is described AT
 * ALL and which credential it claims — both were green while every one of the
 * twelve `/v1` operations published no request body and no success schema, so a
 * generated client POSTed an EMPTY BODY to `/v1/chat/completions` and returned
 * `Any`. Freshness could not see it either: the document matched what the
 * generator produced, and the generator produced nothing.
 *
 * The trap this layer has to avoid is the one that nearly passed for a result: a
 * census of "operations with a response schema" answers 363 of 390, because every
 * operation `$ref`s `Error` for 401/429/5XX. That counts the ERROR ENVELOPE. The
 * success count was 38. So every assertion here separates 2xx from the rest.
 *
 * Layer 4 — the document speaks the DIALECT it declares. It says `openapi: 3.1.0`,
 * and 3.1 is JSON Schema 2020-12: `nullable` was removed, and
 * `exclusiveMinimum`/`exclusiveMaximum` are the bounds themselves rather than
 * booleans modifying `minimum`/`maximum`. Measured on `main`: 10 `nullable: true`
 * and 4 boolean `exclusiveMinimum`, every one of them a constraint a conforming
 * consumer silently drops — so a nullable field was published as non-nullable.
 * This layer also requires a unique `operationId` on every operation, which is how
 * a generator names the function it emits; there were none at all, so each
 * generator invented its own and a client's method names changed with the tool.
 *
 * Layer 5 — the artifact is FRESH. Regenerate and ask git whether the committed
 * file moved. A tracked file changing IS the staleness, with no interpretation
 * needed. This is the only layer that sees a route added, removed or re-gated
 * without the document being regenerated.
 *
 * Layers 1 to 4 read the COMMITTED bytes and need no build. Layer 5 runs the
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

/**
 * The `/v1` operations whose PAYLOADS a published contract must describe, and
 * whether each takes a request body.
 *
 * Named individually and not derived, for the same reason `EXPECTED_PATHS` is: a
 * list computed from the document cannot disagree with it. `requestBody` is part
 * of the expectation rather than inferred from the verb, because "this GET should
 * have a body" and "this POST's body went missing" are opposite failures and a
 * rule over the verb alone would report neither.
 *
 * `POST /v1/voice/token` and `POST /v1/voice/transcribe` are deliberately ABSENT.
 * They are opaque pass-throughs to `https://api.alia.onl` (`routes/alia.ts`), so
 * their request and response shapes belong to another vendor; writing a schema for
 * either would publish a promise Oxy does not make. That is a scope decision, and
 * it is recorded here rather than left as an unexplained gap in the list.
 */
const EXPECTED_PAYLOAD_OPERATIONS = [
  { method: 'post', path: '/v1/responses', requestBody: true },
  { method: 'post', path: '/v1/chat/completions', requestBody: true },
  { method: 'post', path: '/v1/audio/speech', requestBody: true },
  { method: 'post', path: '/v1/images/generations', requestBody: true },
  { method: 'get', path: '/v1/generations/{id}', requestBody: false },
  { method: 'get', path: '/v1/models', requestBody: false },
  { method: 'get', path: '/v1/models/stats', requestBody: false },
  { method: 'get', path: '/v1/models/routing-profiles', requestBody: false },
  { method: 'get', path: '/v1/models/{publisher}/{model}', requestBody: false },
  { method: 'get', path: '/v1/models/{publisher}/{model}/documentation', requestBody: false },
];

/**
 * The keywords a 3.1 document must not contain, with the 3.1 spelling to use.
 *
 * `nullable` is the OpenAPI 3.0 spelling and 3.1 removed it outright; a boolean
 * `exclusiveMinimum`/`exclusiveMaximum` is the 3.0 shape and is the wrong TYPE in
 * 3.1, where the keyword carries the bound. Both are dropped in silence by a
 * conforming consumer, which is what makes them worth a gate: the document keeps
 * reading as if the constraint were there.
 */
const FORBIDDEN_30_KEYWORDS = {
  nullable: 'spell it as a type union, e.g. `type: [string, "null"]`',
  exclusiveMinimum: 'in 3.1 this keyword carries the BOUND, so write `exclusiveMinimum: 0` and drop `minimum`',
  exclusiveMaximum: 'in 3.1 this keyword carries the BOUND, so write `exclusiveMaximum: 10` and drop `maximum`',
};

/** Vacuity floors. A layer that examines nothing must fail, not pass. */
const MINIMUM_EXPECTED_PATHS = 11;
const MINIMUM_EXPECTED_PREFIXES = 4;
const MINIMUM_PAYLOAD_OPERATIONS = 10;
/**
 * The floor on schema nodes the empty-schema walk must actually visit.
 *
 * The PRIMARY control on that walk is the constrained-schema and required-field
 * checks above: a document describing almost nothing fails those first, so the
 * walk's silence is never the only thing standing. This floor guards the different
 * failure of the WALK ITSELF going inert — a future edit to `emptySchemasUnder`
 * that stops recursing reports "no empty schema found" over the same document, and
 * nothing else here would notice.
 *
 * Measured across the ten named operations: 677 nodes. A hundred leaves room for
 * the surface to shrink without the floor becoming the thing that fails, while
 * still being far above what a walk that recursed one level would reach.
 */
const MINIMUM_SCHEMA_NODES_WALKED = 100;

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

/**
 * Whether a schema object actually constrains anything.
 *
 * `{}` is VALID OpenAPI and it means "any value is acceptable", so it is
 * indistinguishable from a considered decision to accept anything. Before the
 * generator grew a `ZodDiscriminatedUnion` case, every discriminated union in
 * `@oxyhq/contracts` converted to exactly this — including
 * `inferenceContentPartSchema`, so the contract said a chat message's content array
 * accepts anything at all.
 */
function schemaConstrainsSomething(schema) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  return ['type', 'properties', 'oneOf', 'anyOf', 'allOf', '$ref', 'enum', 'const'].some((key) =>
    Object.hasOwn(schema, key),
  );
}

/**
 * Every `{}` schema reachable from a schema root, and how many nodes were looked at.
 *
 * `additionalProperties: {}` is EXEMPT, and it is the only exemption: it is what
 * `z.record(z.unknown())` means, and a customer's JSON Schema document or a
 * cost-attribution label map genuinely is opaque. Every other position is a schema
 * that was meant to say something.
 */
function emptySchemasUnder(root) {
  const findings = [];
  let visited = 0;
  const walk = (node, trail, isSchemaPosition) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${trail}[${index}]`, isSchemaPosition));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (isSchemaPosition) {
      visited += 1;
      if (Object.keys(node).length === 0) findings.push(trail);
    }
    for (const [key, value] of Object.entries(node)) {
      // `properties` and `patternProperties` map NAMES to schemas, so their direct
      // children are not schemas and their grandchildren are.
      if (key === 'properties' || key === 'patternProperties') {
        for (const [name, child] of Object.entries(value ?? {})) {
          walk(child, `${trail}.${key}.${name}`, true);
        }
        continue;
      }
      if (key === 'additionalProperties') continue;
      const childIsSchema = ['items', 'oneOf', 'anyOf', 'allOf', 'not', 'schema'].includes(key);
      walk(value, `${trail}.${key}`, childIsSchema);
    }
  };
  walk(root, '', true);
  return { findings, visited };
}

/** The 2xx responses of an operation that carry a described body. */
function describedSuccessResponses(operation) {
  return Object.entries(operation?.responses ?? {}).filter(([code, response]) => {
    if (!code.startsWith('2')) return false;
    const content = response?.content;
    if (typeof content !== 'object' || content === null) return false;
    return Object.values(content).some((media) => schemaConstrainsSomething(media?.schema));
  });
}

/** Layer 3: the named `/v1` operations describe their request and success payloads. */
function undescribedPayloads(paths) {
  if (EXPECTED_PAYLOAD_OPERATIONS.length < MINIMUM_PAYLOAD_OPERATIONS) {
    console.error(
      `The payload-expectation list holds ${EXPECTED_PAYLOAD_OPERATIONS.length} entr(ies), below ` +
        `the floor of ${MINIMUM_PAYLOAD_OPERATIONS}. Dropping an entry is how this layer stops\n` +
        'measuring anything, so shrinking the list has to be a deliberate edit to the floor too.',
    );
    process.exit(1);
  }

  const findings = [];
  let schemaNodesWalked = 0;

  for (const expected of EXPECTED_PAYLOAD_OPERATIONS) {
    const label = `${expected.method.toUpperCase()} ${expected.path}`;
    const operation = paths[expected.path]?.[expected.method];
    if (operation === undefined) {
      findings.push(`${label} is not described at all, so it has no payload to check.`);
      continue;
    }

    if (expected.requestBody) {
      const schema = operation.requestBody?.content?.['application/json']?.schema;
      if (!schemaConstrainsSomething(schema)) {
        findings.push(
          `${label} publishes no constrained \`application/json\` request body, so a generated ` +
            'client sends an EMPTY body.',
        );
      } else if (!Array.isArray(schema.required) || schema.required.length === 0) {
        // Every one of the four POSTs has required fields — `model` and `messages`
        // on the compatibility surface, `input` on `/v1/responses`. A body schema
        // with none is the shape a client can satisfy by sending `{}`, which is
        // exactly the defect: the generated `post_v1_chat_completions` took no
        // `model` and no `messages`.
        findings.push(
          `${label} publishes a request body with no required field, so \`{}\` satisfies it.`,
        );
      } else {
        const { findings: empties, visited } = emptySchemasUnder(schema);
        schemaNodesWalked += visited;
        for (const trail of empties) {
          findings.push(
            `${label} request body has an EMPTY schema at \`${trail || '(root)'}\`, which publishes ` +
              'it as accepting any value.',
          );
        }
      }
    } else if (operation.requestBody !== undefined) {
      findings.push(`${label} publishes a request body, but this operation takes none.`);
    }

    const successes = describedSuccessResponses(operation);
    if (successes.length === 0) {
      findings.push(
        `${label} declares no 2xx response with a constrained schema, so a generated client ` +
          'returns an untyped value. (An `Error` \`$ref\` on 401/429/5XX is not a success schema.)',
      );
      continue;
    }
    for (const [code, response] of successes) {
      for (const [mediaType, media] of Object.entries(response.content)) {
        const { findings: empties, visited } = emptySchemasUnder(media.schema);
        schemaNodesWalked += visited;
        for (const trail of empties) {
          findings.push(
            `${label} response ${code} (${mediaType}) has an EMPTY schema at ` +
              `\`${trail || '(root)'}\`, which publishes it as any value.`,
          );
        }
      }
    }
  }

  if (findings.length === 0 && schemaNodesWalked < MINIMUM_SCHEMA_NODES_WALKED) {
    findings.push(
      `the empty-schema walk looked at ${schemaNodesWalked} schema node(s), below its floor of ` +
        `${MINIMUM_SCHEMA_NODES_WALKED}. "No empty schema found" over a document that describes ` +
        'almost nothing is the same output as over a correct one, so its silence carries no ' +
        'information.',
    );
  }
  return findings;
}

/** Layer 4: the document speaks the OpenAPI dialect it declares. */
function dialectViolations(document) {
  const findings = [];
  const version = String(document.openapi ?? '');
  if (!version.startsWith('3.1')) {
    findings.push(
      `the document declares \`openapi: ${version || '(missing)'}\`. This gate is written for 3.1, ` +
        'which is the version the base document declares; a downgrade needs a deliberate edit here.',
    );
    return findings;
  }

  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${trail}[${index}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [keyword, remedy] of Object.entries(FORBIDDEN_30_KEYWORDS)) {
      if (!Object.hasOwn(node, keyword)) continue;
      // `nullable` is never valid in 3.1. The two exclusive bounds ARE, as
      // numbers — only the boolean form is the 3.0 shape.
      if (keyword !== 'nullable' && typeof node[keyword] !== 'boolean') continue;
      findings.push(`${trail || '(root)'}.${keyword} is the OpenAPI 3.0 spelling — ${remedy}.`);
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${trail}.${key}`);
  };
  walk(document.paths ?? {}, 'paths');
  walk(document.components ?? {}, 'components');

  const seen = new Map();
  let operationsSeen = 0;
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [verb, operation] of Object.entries(methods ?? {})) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(verb)) continue;
      operationsSeen += 1;
      const operationId = operation?.operationId;
      if (typeof operationId !== 'string' || operationId.length === 0) {
        findings.push(
          `${verb.toUpperCase()} ${path} has no \`operationId\`, so every generator invents its ` +
            'own name for the function it emits and the client renames itself on upgrade.',
        );
        continue;
      }
      const collision = seen.get(operationId);
      if (collision !== undefined) {
        findings.push(
          `operationId "${operationId}" is claimed by both ${collision} and ` +
            `${verb.toUpperCase()} ${path}, which is invalid OpenAPI.`,
        );
      }
      seen.set(operationId, `${verb.toUpperCase()} ${path}`);
    }
  }
  if (operationsSeen < MINIMUM_EXPECTED_PATHS) {
    findings.push(
      `the dialect layer examined ${operationsSeen} operation(s), which is fewer than the ` +
        `${MINIMUM_EXPECTED_PATHS} paths layer 1 already guarantees. It is reading almost nothing.`,
    );
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

const undescribed = undescribedPayloads(committed.paths);
if (undescribed.length > 0) {
  reportAndExit(
    `${DOCUMENT} describes the /v1 surface but not its PAYLOADS.`,
    undescribed,
    'A published operation with no request body and no success schema generates a client\n' +
      'method that takes nothing and returns an untyped value. Measured before this layer\n' +
      'existed: all twelve /v1 operations were in that state, and a generated\n' +
      '`post_v1_chat_completions` POSTed an empty body and returned `Any`. It imported and\n' +
      'type-checked; it could not make a chat completion.\n\n' +
      'Fix, in packages/api/src/routes/:\n' +
      '  - request body: use `validate({ body })`, or add an `@requestBody <schemaIdentifier>`\n' +
      '    line to the JSDoc above the route when it validates inside the handler.\n' +
      '  - success body: add `@response <code> <schemaIdentifier>` to the same JSDoc, and\n' +
      '    annotate the object the handler passes to `res.json` with the schema\'s own\n' +
      '    `z.infer<typeof …>` so `tsc` holds the two together.\n' +
      'Both identifiers must be IMPORTED by the route file, from ../schemas/* or\n' +
      '@oxyhq/contracts. Then regenerate with `bun run openapi:generate`.',
  );
}

const dialect = dialectViolations(committed.document);
if (dialect.length > 0) {
  reportAndExit(
    `${DOCUMENT} does not speak the OpenAPI dialect it declares.`,
    dialect,
    'The document declares 3.1.0, which is JSON Schema 2020-12. A 3.0-only keyword there is\n' +
      'not a style question — a conforming consumer drops it in silence, so the constraint\n' +
      'reads as present and is not enforced.\n\n' +
      'The converter in packages/api/scripts/generate-openapi.ts emits the 3.1 spellings;\n' +
      'a violation therefore comes from a hand-written `@openapi` JSDoc block in a route\n' +
      'file, or from openapi.base.yaml. Fix it there and regenerate.',
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
    `${DOCUMENT} is fresh, describes ${EXPECTED_PATHS.length} named inference path(s), ` +
      `${credentialledPaths(committed.paths).length} credentialled inference operation-path(s) and ` +
      `${EXPECTED_PAYLOAD_OPERATIONS.length} /v1 operation payload(s).`,
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
