#!/usr/bin/env bun
/**
 * generate-openapi.ts — emit a fully-resolved `openapi.json` for the Oxy
 * REST API.
 *
 * Strategy:
 *   1. Start with a hand-maintained `openapi.base.yaml` so info, security
 *      schemes, servers, tags and shared component schemas stay stable.
 *   2. Run `swagger-jsdoc` against `src/routes/**\/*.ts` to pull paths from
 *      `@openapi` JSDoc blocks (the same machinery the in-process `/docs`
 *      endpoint already uses). These hand-curated docs always take precedence.
 *   3. Walk the route files and synthesize entries for any
 *      `router.<verb>('/path', ...)` calls that don't already have an
 *      `@openapi` block. For these synthesised entries the generator:
 *        * extracts the natural-language `/** ... *\/` comment block above
 *          the handler and uses its text as the description / summary
 *        * inspects the `validate({ body, params, query })` middleware and
 *          converts attached Zod schemas to inline OpenAPI schemas
 *        * extracts path/query parameters from the Express route pattern and
 *          attached schemas
 *        * tags by mount prefix using a human-friendly mapping
 *          (e.g. `/auth/*` → "Authentication")
 *        * infers required security (bearerAuth for anything that uses
 *          `authMiddleware` or `emailCapabilityAuth`, serviceTokenAuth for
 *          `serviceAuthMiddleware`)
 *        * applies the standard error envelope for 4xx/5xx responses.
 *   4. Write the merged document to `packages/api/openapi.json` so the website
 *      sync step can copy it via `git show <ref>:openapi.json`.
 *
 * The route walker is intentionally regex-based — it doesn't need a full TS
 * parser, but it does need to recognise the conventions the route files
 * actually use today. Update `MOUNT_MAP`, `TAG_GROUPS`, and the Zod schema
 * loader when extending the API.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import swaggerJsdoc from 'swagger-jsdoc';
import { z, ZodTypeAny } from 'zod';
import { INBOX_CAPABILITY_CATALOG } from '../src/capabilities/inbox.catalog';

interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  security?: unknown[];
  [key: string]: unknown;
}

interface OpenApiDocument {
  openapi: string;
  info: OpenApiInfo;
  servers: Array<{ url: string; description?: string }>;
  components: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown>; [key: string]: unknown };
  paths: Record<string, Record<string, OpenApiOperation>>;
  tags?: Array<{ name: string; description?: string }>;
  [key: string]: unknown;
}

// `__dirname`, not `import.meta.dir`: this package compiles as CommonJS
// (`module: NodeNext`, no `"type": "module"`), where `import.meta` is a type
// error. Bun populates `__dirname` identically when running this file.
const PACKAGE_ROOT = path.resolve(__dirname, '..');
/**
 * Schema modules that could not be imported.
 *
 * This exists because the generator used to log an import failure and CARRY ON,
 * emitting a document with those schemas silently missing and exiting 0. That is
 * the worst possible shape for a tool that writes a PUBLISHED contract: the
 * output looks complete, nothing about the run says otherwise, and the drift is
 * discovered later by whoever trusted it. Measured before this change —
 * `@oxyhq/contracts` and `@oxyhq/db` unbuilt dropped `components.schemas` from
 * 7 to 4, and the run still reported success.
 *
 * A generator that quietly emits a partial contract is worse than the drift it
 * causes, so the run now refuses to write at all.
 */
const schemaImportFailures: Array<{ filename: string; error: unknown }> = [];

/**
 * Zod type names `zodToOpenApi` has no case for.
 *
 * Same refusal as `schemaImportFailures`, one layer down, and for a sharper
 * reason: an unhandled type does not produce a missing schema, it produces `{}` —
 * which is a VALID OpenAPI schema meaning "any value is acceptable". A consumer
 * cannot tell it apart from a deliberate `z.unknown()`, so the document reads as
 * a considered decision to accept anything.
 *
 * Measured on `main`: `ZodDiscriminatedUnion` (20 instances reachable from the
 * api's schema modules) and `ZodBranded` (5) both hit the default arm. Eleven of
 * those unions are the inference request surface, so the published contract
 * described a chat message's content parts, a routing target, a response format
 * and a stream event as unconstrained.
 */
const unconvertibleZodTypes: string[] = [];

/**
 * Schema identifiers a route names but whose module could not be resolved.
 *
 * Third member of the same family. A `validate({ body: createFooSchema })` whose
 * identifier cannot be resolved used to mean the operation was published with NO
 * `requestBody` at all — a contract saying the endpoint takes an empty body, from
 * a route that rejects one. Recorded and refused for the same reason as the two
 * above: the document that would be written looks finished.
 */
const unresolvedSchemaReferences: Array<{
  filename: string;
  identifier: string;
  reason: string;
}> = [];

const BASE_YAML = path.join(PACKAGE_ROOT, 'openapi.base.yaml');
const OUTPUT_JSON = path.join(PACKAGE_ROOT, 'openapi.json');
const ROUTES_DIR = path.join(PACKAGE_ROOT, 'src', 'routes');
const SCHEMAS_DIR = path.join(PACKAGE_ROOT, 'src', 'schemas');

/* ------------------------ minimal YAML loader ------------------------ */
/**
 * Tiny YAML parser. The base document is hand-curated and uses only a
 * conservative subset (scalars, lists, nested maps, single-line block strings).
 * We avoid a runtime dep so the build doesn't grow.
 */
export function parseYaml(input: string): OpenApiDocument {
  const lines = input.split(/\r?\n/);
  let i = 0;

  function parseBlock(indent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (i < lines.length) {
      const rawLine = lines[i];
      if (rawLine === undefined) {
        i += 1;
        continue;
      }
      if (!rawLine.trim() || rawLine.trim().startsWith('#')) {
        i += 1;
        continue;
      }
      const lineIndent = rawLine.length - rawLine.trimStart().length;
      if (lineIndent < indent) return obj;
      const line = rawLine.slice(indent);
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) return obj;
      const key = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      i += 1;
      // A block-scalar header, with its optional chomping indicator: `>`, `>-`,
      // `>+`, `|`, `|-`, `|+`.
      //
      // `>-` used to fall through to `parseScalar`, which returned the literal
      // string ">-" and then read the indented body as further KEYS — silently
      // dropping every sibling schema after it. Measured: `components.schemas`
      // went 7 -> 4 and `User.id.description` came back as ">-", and none of it
      // surfaced until a regeneration was compared against the committed
      // document. A parser that mis-reads standard YAML into plausible-looking
      // garbage is the same failure as the generator writing a partial document,
      // one layer down, so the unrecognised case now THROWS rather than guessing.
      const blockHeader = /^([>|])([-+]?)$/.exec(rest);
      if (!blockHeader && (rest.startsWith('>') || rest.startsWith('|'))) {
        throw new Error(
          `openapi.base.yaml: unsupported block scalar header "${rest}" for key "${key}". `
          + 'This minimal parser understands >, >-, >+, |, |- and |+ only — an explicit '
          + 'indentation indicator (e.g. ">2") is not supported. Rewrite the value or extend '
          + 'parseYaml; do NOT leave it, because the fallback would read the header as a '
          + 'string and silently swallow the keys that follow.',
        );
      }
      if (rest === '' || blockHeader) {
        // Possibly a folded/block scalar.
        if (blockHeader) {
          const lines2: string[] = [];
          const childIndent = indent + 2;
          while (i < lines.length) {
            const ln = lines[i];
            if (ln === undefined) {
              i += 1;
              continue;
            }
            if (!ln.trim()) {
              lines2.push('');
              i += 1;
              continue;
            }
            const ind = ln.length - ln.trimStart().length;
            if (ind < childIndent) break;
            lines2.push(ln.slice(childIndent));
            i += 1;
          }
          // Folded (`>`) joins with spaces, literal (`|`) keeps newlines. The
          // folded branch keeps its existing `.trim()` so every description
          // already in this file renders byte-identically; `-` (strip) on the
          // literal branch removes the trailing newlines it would otherwise
          // keep. `+` (keep) is accepted and treated as the default, which is
          // exact for folded and near enough for literal — no value in this
          // document relies on trailing blank lines.
          obj[key] = blockHeader[1] === '>'
            ? lines2.join(' ').trim()
            : (blockHeader[2] === '-' ? lines2.join('\n').replace(/\n+$/, '') : lines2.join('\n'));
          continue;
        }
        // Either nested object or list follows.
        const next = lines[i];
        if (next !== undefined && next.trimStart().startsWith('- ')) {
          // List of scalars / maps.
          const listIndent = next.length - next.trimStart().length;
          const list: unknown[] = [];
          while (i < lines.length) {
            const ln = lines[i];
            if (ln === undefined) {
              i += 1;
              continue;
            }
            if (!ln.trim()) {
              i += 1;
              continue;
            }
            const ind = ln.length - ln.trimStart().length;
            if (ind < listIndent) break;
            if (!ln.trimStart().startsWith('- ')) break;
            const itemRest = ln.trimStart().slice(2);
            i += 1;
            if (itemRest.includes(':')) {
              // Parse a map starting from this line.
              const itemMap: Record<string, unknown> = {};
              const colon = itemRest.indexOf(':');
              const k = itemRest.slice(0, colon).trim();
              const v = itemRest.slice(colon + 1).trim();
              if (v) itemMap[k] = parseScalar(v);
              const nested = parseBlock(listIndent + 2);
              Object.assign(itemMap, nested);
              list.push(itemMap);
            } else {
              list.push(parseScalar(itemRest));
            }
          }
          obj[key] = list;
        } else {
          obj[key] = parseBlock(indent + 2);
        }
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  function parseScalar(raw: string): unknown {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null' || raw === '~') return null;
    if (raw === '[]') return [];
    if (raw === '{}') return {};
    if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1);
    }
    // Inline flow-array of scalars: [a, b, c]
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map((s) => parseScalar(s.trim()));
    }
    return raw;
  }

  return parseBlock(0) as unknown as OpenApiDocument;
}

/* --------------------- Zod → OpenAPI converter ----------------------- */
/**
 * Convert a Zod schema instance to an OpenAPI 3.1 schema fragment.
 *
 * Supports the subset the api package actually uses: object, string, number,
 * boolean, array, enum, union, literal, optional, nullable, default, record,
 * and `superRefine` (treated as the underlying object schema).
 */
export function zodToOpenApi(schema: ZodTypeAny): Record<string, unknown> {
  if (!schema || typeof (schema as { _def?: unknown })._def !== 'object') {
    return { type: 'string' };
  }
  const def = (schema as { _def: { typeName?: string; [key: string]: unknown } })._def;
  const typeName = def.typeName ?? '';

  switch (typeName) {
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; regex?: RegExp; message?: string }>;
      // A chain can carry SEVERAL length checks, and the published bound must be
      // the tightest of them rather than the last one seen — see the number case
      // below for the measured consequence of taking the last.
      let minLength: number | undefined;
      let maxLength: number | undefined;
      for (const c of checks) {
        if (c.kind === 'min' && typeof c.value === 'number') {
          minLength = minLength === undefined ? c.value : Math.max(minLength, c.value);
        }
        if (c.kind === 'max' && typeof c.value === 'number') {
          maxLength = maxLength === undefined ? c.value : Math.min(maxLength, c.value);
        }
        if (c.kind === 'email') out.format = 'email';
        if (c.kind === 'url') out.format = 'uri';
        if (c.kind === 'uuid') out.format = 'uuid';
        if (c.kind === 'cuid' || c.kind === 'cuid2') out.format = c.kind;
        if (c.kind === 'datetime') out.format = 'date-time';
        if (c.kind === 'regex' && c.regex instanceof RegExp) out.pattern = c.regex.source;
        if (c.kind === 'length' && typeof c.value === 'number') {
          minLength = minLength === undefined ? c.value : Math.max(minLength, c.value);
          maxLength = maxLength === undefined ? c.value : Math.min(maxLength, c.value);
        }
      }
      if (minLength !== undefined) out.minLength = minLength;
      if (maxLength !== undefined) out.maxLength = maxLength;
      return out;
    }
    case 'ZodNumber': {
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; inclusive?: boolean }>;
      let type = 'number';
      // The TIGHTEST bound of each direction, not the last one written down.
      //
      // `.positive().safe()` produces two `min` checks — `0` exclusive, then
      // `-Number.MAX_SAFE_INTEGER` inclusive — and overwriting on each one
      // published the LOOSEST. Measured: `policyVersion` on
      // `GET /inference/routing-policies/{policyId}/versions/{policyVersion}` is
      // `z.coerce.number().int().positive().safe()` and the contract said it
      // accepts -9007199254740991. Losing a bound is the same class of defect as
      // publishing `{}`: the document states something the server refuses.
      let minimum: { value: number; exclusive: boolean } | undefined;
      let maximum: { value: number; exclusive: boolean } | undefined;
      for (const c of checks) {
        if (c.kind === 'int') type = 'integer';
        if (c.kind === 'min' && typeof c.value === 'number') {
          const candidate = { value: c.value, exclusive: c.inclusive === false };
          if (
            minimum === undefined ||
            candidate.value > minimum.value ||
            (candidate.value === minimum.value && candidate.exclusive)
          ) {
            minimum = candidate;
          }
        }
        if (c.kind === 'max' && typeof c.value === 'number') {
          const candidate = { value: c.value, exclusive: c.inclusive === false };
          if (
            maximum === undefined ||
            candidate.value < maximum.value ||
            (candidate.value === maximum.value && candidate.exclusive)
          ) {
            maximum = candidate;
          }
        }
      }
      const out: Record<string, unknown> = { type };
      // OpenAPI 3.1 is JSON Schema 2020-12, where `exclusiveMinimum` is the BOUND
      // ITSELF and not a boolean modifier on `minimum`. This document declares
      // 3.1.0 (`openapi.base.yaml:1`), so the 3.0 spelling `minimum: 0,
      // exclusiveMinimum: true` is not merely stylistic — `true` is the wrong TYPE
      // there, so a strict consumer either rejects the schema or ignores the
      // keyword and admits the excluded value.
      if (minimum !== undefined) {
        if (minimum.exclusive) out.exclusiveMinimum = minimum.value;
        else out.minimum = minimum.value;
      }
      if (maximum !== undefined) {
        if (maximum.exclusive) out.exclusiveMaximum = maximum.value;
        else out.maximum = maximum.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodLiteral': {
      const value = (def as { value: unknown }).value;
      const t = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
      return { type: t, enum: [value] };
    }
    case 'ZodEnum': {
      const values = ((def as { values?: string[] }).values ?? []) as string[];
      return { type: 'string', enum: values };
    }
    case 'ZodNativeEnum': {
      const values = Object.values(((def as { values?: Record<string, string | number> }).values ?? {}));
      return { type: typeof values[0] === 'number' ? 'integer' : 'string', enum: values };
    }
    case 'ZodArray': {
      const items = zodToOpenApi(((def as { type: ZodTypeAny }).type));
      const out: Record<string, unknown> = { type: 'array', items };
      const minItems = (def as { minLength?: { value: number } | null }).minLength;
      const maxItems = (def as { maxLength?: { value: number } | null }).maxLength;
      if (minItems && typeof minItems.value === 'number') out.minItems = minItems.value;
      if (maxItems && typeof maxItems.value === 'number') out.maxItems = maxItems.value;
      return out;
    }
    case 'ZodObject': {
      const shape = (schema as { _def: { shape: () => Record<string, ZodTypeAny> } })._def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape) as Array<[string, ZodTypeAny]>) {
        properties[key] = zodToOpenApi(value);
        const valueDef = (value as { _def?: { typeName?: string } })._def;
        const isOptional = valueDef?.typeName === 'ZodOptional' || valueDef?.typeName === 'ZodDefault';
        if (!isOptional) required.push(key);
      }
      const out: Record<string, unknown> = {
        type: 'object',
        properties,
      };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodRecord': {
      const valueType = (def as { valueType?: ZodTypeAny }).valueType;
      return {
        type: 'object',
        additionalProperties: valueType ? zodToOpenApi(valueType) : true,
      };
    }
    case 'ZodOptional': {
      return zodToOpenApi((def as { innerType: ZodTypeAny }).innerType);
    }
    case 'ZodNullable': {
      const inner = zodToOpenApi((def as { innerType: ZodTypeAny }).innerType);
      // `nullable: true` is the OpenAPI 3.0 spelling and 3.1 REMOVED it. In a 3.1
      // document — which this one declares itself to be — it is an unknown keyword
      // that every conforming consumer ignores, so a nullable field was published
      // as NOT nullable and a generated client typed it non-optional. 3.1 spells it
      // as a union with the `null` type.
      const nullType = { type: 'null' };
      if (Array.isArray(inner.oneOf)) {
        return { ...inner, oneOf: [...(inner.oneOf as unknown[]), nullType] };
      }
      if (typeof inner.type === 'string') {
        const widened: Record<string, unknown> = { ...inner, type: [inner.type, 'null'] };
        // An `enum` constrains the value set as well as the type, so `null` has to
        // be admitted there too or the widened type admits nothing new.
        if (Array.isArray(inner.enum)) widened.enum = [...(inner.enum as unknown[]), null];
        return widened;
      }
      // No `type` and no `oneOf` — an unconstrained inner schema (`z.any()`,
      // `z.unknown()`) already admits null.
      return inner;
    }
    case 'ZodDefault': {
      const innerSchema = zodToOpenApi((def as { innerType: ZodTypeAny }).innerType);
      try {
        const defaultFn = (def as { defaultValue: () => unknown }).defaultValue;
        innerSchema.default = defaultFn();
      } catch {
        // Default produced an error — drop it; OpenAPI default is optional anyway.
      }
      return innerSchema;
    }
    case 'ZodUnion': {
      const options = (def as { options: ZodTypeAny[] }).options.map((option) => zodToOpenApi(option));
      return { oneOf: options };
    }
    case 'ZodEffects': {
      // superRefine / refine wraps the underlying schema. Unwrap and reuse.
      return zodToOpenApi((def as { schema: ZodTypeAny }).schema);
    }
    case 'ZodPipeline': {
      return zodToOpenApi((def as { out: ZodTypeAny }).out);
    }
    case 'ZodDiscriminatedUnion': {
      // The highest-value case in this function, and the one whose absence was
      // invisible. A discriminated union used to fall through to the `default`
      // arm below and be published as `{}` — which in OpenAPI does not mean
      // "shape unknown", it means ANY VALUE IS VALID. Measured on `main`: eleven
      // discriminated unions in `@oxyhq/contracts`' inference namespace alone
      // were published as unconstrained, `inferenceContentPartSchema` among them
      // — so the published contract said a chat message's content array accepts
      // anything at all, and a generated client typed it `Any`.
      //
      // `discriminator` is emitted beside `oneOf` rather than instead of it: a
      // consumer that understands the keyword gets the fast, unambiguous
      // dispatch, and one that ignores it still validates against the branches.
      const discriminator = (def as { discriminator: string }).discriminator;
      const options = (def as { options: ZodTypeAny[] }).options.map((option) => zodToOpenApi(option));
      return { oneOf: options, discriminator: { propertyName: discriminator } };
    }
    case 'ZodBranded': {
      // A brand is a compile-time-only distinction; the wire shape is the inner
      // schema's. Reached from `@oxyhq/contracts` identifier types.
      return zodToOpenApi((def as { type: ZodTypeAny }).type);
    }
    case 'ZodAny':
    case 'ZodUnknown':
      // The only two types for which an empty schema is the TRUTH: both really do
      // accept any value. Every other unhandled type reaching the arm below would
      // publish the same bytes while meaning something else entirely, which is why
      // that arm records rather than returns.
      return {};
    default:
      // A zod type this converter does not know produces the same `{}` as
      // `ZodAny` — indistinguishable on the wire, and a lie about every schema
      // that is not genuinely unconstrained. So it is RECORDED and the run
      // refuses to write, in the same way an unimportable schema module does.
      // Before this arm existed, `ZodDiscriminatedUnion` and `ZodBranded` both
      // landed here and nothing anywhere said so.
      if (!unconvertibleZodTypes.includes(typeName)) unconvertibleZodTypes.push(typeName);
      return {};
  }
}

/**
 * Load one module a schema reference resolves through, memoized.
 *
 * `specifier` is what the route file wrote — `../schemas/email.schemas` or
 * `@oxyhq/contracts` — narrowed by `schemaModuleSpecifier` before it gets here,
 * so nothing with side effects is ever imported.
 */
const loadedSchemaModules = new Map<string, Record<string, unknown>>();

async function loadSchemaModule(specifier: string): Promise<Record<string, unknown>> {
  const cached = loadedSchemaModules.get(specifier);
  if (cached !== undefined) return cached;

  const target = specifier.startsWith('../schemas/')
    ? path.join(SCHEMAS_DIR, `${specifier.slice('../schemas/'.length)}.ts`)
    : specifier;

  if (target !== specifier && !existsSync(target)) {
    // A relative specifier naming a file that is not there is the `models-stats.ts`
    // failure one layer down: it looks exactly like a module that exports nothing.
    schemaImportFailures.push({
      filename: specifier,
      error: new Error(`no such file: ${path.relative(PACKAGE_ROOT, target)}`),
    });
    loadedSchemaModules.set(specifier, {});
    return {};
  }

  try {
    const mod = (await import(target)) as Record<string, unknown>;
    loadedSchemaModules.set(specifier, mod);
    return mod;
  } catch (err) {
    // Recorded rather than swallowed. Continuing past a failed import is
    // deliberate — one run should name EVERY unimportable module rather than
    // stopping at the first — but the run must not then write a document, and
    // `schemaImportFailures` is what makes that impossible to forget.
    schemaImportFailures.push({ filename: specifier, error: err });
    loadedSchemaModules.set(specifier, {});
    return {};
  }
}

/** Whether a resolved export is a Zod schema rather than, say, a type or a helper. */
function isZodSchema(value: unknown): value is ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { _def?: unknown })._def === 'object'
  );
}

/* ----------------------- route walker (stub gen) --------------------- */

interface ValidateCall {
  body?: string;
  params?: string;
  query?: string;
}

/**
 * One `@response` line from a route's leading JSDoc.
 *
 * See {@link parseResponseTags} for the syntax and for why the success response
 * is DECLARED at the route rather than inferred from the handler.
 */
interface ResponseTag {
  status: string;
  mediaType: string;
  /** A Zod schema identifier, or `binary` for a byte body. */
  schemaRef: string;
  description: string;
}

interface RouteEntry {
  verb: string;
  mountPrefix: string;
  pathSuffix: string;
  filename: string;
  /** Natural-language description from the leading JSDoc comment. */
  jsdoc?: string;
  /** Inline `validate({...})` schema identifiers. */
  validate?: ValidateCall;
  /** `@response` declarations from the leading JSDoc. */
  responseTags: ResponseTag[];
  /** `@requestBody` declaration from the leading JSDoc, for routes that validate inline. */
  requestBodyTag?: string;
  /** Identifier → module specifier, from the route file's own imports. */
  imports: Record<string, string>;
  /** Top-level `const` names the route file declares itself. */
  localConsts: string[];
  /** Middleware tokens applied between the path and handler. */
  middlewares: string[];
}

/**
 * Mount map: route file basename → the Express mount prefixes it is served
 * under (from `server.ts`). Kept in sync with the order of `app.use(...)` calls.
 *
 * The value is a LIST because a router may legitimately be mounted more than
 * once, and a single-string map could not say so: `inferenceCatalogue.ts` is
 * mounted at both `/v1/models` (the public edge dialect) and `/models` (the URL
 * Console still calls). Describing one and omitting the other would publish a
 * contract that is silently narrower than the server.
 */
const MOUNT_MAP: Record<string, readonly string[]> = {
  'auth.ts': ['/auth'],
  'authLinking.ts': ['/auth'],
  'assets.ts': ['/assets'],
  'cdn.ts': ['/cdn'],
  'storage.ts': ['/storage'],
  'search.ts': ['/search'],
  'profiles.ts': ['/profiles'],
  'users.ts': ['/users'],
  'userData.ts': ['/users/me/app-data'],
  'sessionDevice.ts': ['/session/device'],
  'session.ts': ['/session'],
  'privacy.ts': ['/privacy'],
  'analytics.routes.ts': ['/analytics'],
  'payment.routes.ts': ['/payments'],
  'notifications.routes.ts': ['/notifications'],
  'reputation.routes.ts': ['/reputation'],
  'wallet.routes.ts': ['/wallet'],
  'linkMetadata.ts': ['/link-metadata'],
  'links.ts': ['/links'],
  'locationSearch.ts': ['/location-search'],
  'applications.ts': ['/applications'],
  'accounts.ts': ['/accounts'],
  'devices.ts': ['/devices'],
  'security.ts': ['/security'],
  'subscription.routes.ts': ['/subscription'],
  'emailProxy.ts': ['/email/proxy'],
  'emailInbound.ts': ['/email/inbound'],
  'email.ts': ['/email'],
  'inboxInference.ts': ['/email/ai'],
  'credits.ts': ['/credits'],
  'billing.ts': ['/billing'],
  'inferenceEdge.ts': ['/v1'],
  'inferenceCatalogue.ts': ['/v1/models', '/models'],
  'inferenceAdmin.ts': ['/inference/admin'],
  'inferenceRoutingPolicies.ts': ['/inference/routing-policies'],
  'inferenceProviderConnections.ts': ['/inference/provider-connections'],
  'inferenceReporting.ts': ['/inference/reporting'],
  'platform-stats.ts': ['/platform-stats'],
  'topics.routes.ts': ['/topics'],
  'contacts.ts': ['/contacts'],
  'appSignals.ts': ['/app-signals'],
  'identity.ts': ['/identity'],
  'civic.ts': ['/civic'],
  'nodes.ts': ['/nodes'],
  'federation.ts': ['/federation'],
  'did.ts': ['/'],
};

/**
 * Human-friendly tag for each mount prefix. Mirrors the `tags` block in
 * `openapi.base.yaml`.
 */
const TAG_GROUPS: Record<string, string> = {
  '/auth': 'Authentication',
  '/assets': 'Files',
  '/cdn': 'Files',
  '/storage': 'Files',
  '/search': 'Search',
  '/profiles': 'Profiles',
  '/users': 'Users',
  '/users/me/app-data': 'Users',
  '/session/device': 'Sessions',
  '/session': 'Sessions',
  '/privacy': 'Privacy',
  '/analytics': 'Analytics',
  '/payments': 'Payments',
  '/notifications': 'Notifications',
  '/reputation': 'Reputation',
  '/wallet': 'Wallet',
  '/link-metadata': 'Misc',
  '/links': 'Misc',
  '/location-search': 'Misc',
  '/applications': 'Developer',
  '/accounts': 'Users',
  '/devices': 'Devices',
  '/security': 'Security',
  '/subscription': 'Subscription',
  '/email/proxy': 'Email',
  '/email/inbound': 'Email',
  '/email': 'Email',
  '/credits': 'Credits',
  '/billing': 'Billing',
  '/v1': 'Inference',
  '/v1/models': 'Inference',
  '/models': 'Inference',
  '/inference/admin': 'Inference',
  '/inference/routing-policies': 'Inference',
  '/inference/provider-connections': 'Inference',
  '/inference/reporting': 'Inference',
  '/platform-stats': 'System',
  '/topics': 'Misc',
  '/contacts': 'Contacts',
  '/app-signals': 'Analytics',
  '/identity': 'Identity',
  '/civic': 'Identity',
  '/nodes': 'System',
  '/federation': 'Federation',
  '/': 'Identity',
};

/**
 * Identifier → module specifier, read from the file's OWN import statements.
 *
 * This replaces a hand-maintained `SCHEMA_MODULE_MAP` (route basename → one
 * schemas file), and the reason is the standing rule that a gate which skips what
 * a hand-maintained map omits is not a gate. Measured on `main`: that map named
 * 20 route files, while 13 MOUNTED route files used `validate({ … })` and were
 * absent from it — including every inference route file. A schema reference from
 * an unmapped file resolved to `undefined`, and `buildOperation` then emitted the
 * operation with no `requestBody` and no query parameters, in silence. The whole
 * `/v1` surface was published as taking an empty body.
 *
 * A map also could not express the second half of the truth: a route may validate
 * against a schema from `@oxyhq/contracts` rather than from `src/schemas/`, and 20
 * `validate()` references do exactly that. One entry per file cannot name two
 * modules.
 *
 * Read from the comment-blanked copy, for the same reason every other scan here
 * is: an import line quoted inside prose is not an import.
 */
export function parseImportBindings(source: string): Record<string, string> {
  const bindings: Record<string, string> = {};
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    for (const raw of (match[1] ?? '').split(',')) {
      const clause = raw.trim().replace(/^type\s+/, '');
      if (clause.length === 0) continue;
      // `a as b` binds the LOCAL name, which is what a route body references.
      const local = clause.includes(' as ') ? clause.split(' as ').pop()?.trim() : clause;
      if (local !== undefined && local.length > 0) bindings[local] = specifier;
    }
  }
  return bindings;
}

/**
 * Top-level `const` names the file declares itself.
 *
 * Not resolvable — importing a route module would execute it, and these files
 * build routers, rate limiters and clients at module scope. Recorded separately
 * from "unknown identifier" only so the failure message can say what to do about
 * it, which is to move the schema into `src/schemas/` and import it.
 */
export function parseLocalConstNames(source: string): string[] {
  return [...source.matchAll(/^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * The module specifiers a schema reference may be resolved through.
 *
 * A closed list rather than "try importing whatever it says". A route imports
 * express, its own services, its middleware and its models, and importing any of
 * those to look for a Zod schema would execute code with side effects for no
 * possible gain. Everything else is an unresolved reference, which the run then
 * refuses to write over.
 */
function schemaModuleSpecifier(specifier: string): string | undefined {
  // `.js` suffixes appear on a few NodeNext-style relative imports and name the
  // same TypeScript source.
  const bare = specifier.replace(/\.js$/, '');
  if (bare.startsWith('../schemas/')) return bare;
  if (bare === '@oxyhq/contracts') return bare;
  return undefined;
}

const VERB_RE = /^(get|post|put|delete|patch)$/i;

/**
 * Find the leading `/** ... *\/` block immediately above a position in a
 * source file. Returns the cleaned-up text (no comment markers, no `* `
 * prefixes), or undefined if there's no comment directly above.
 */
function findLeadingComment(source: string, position: number): string | undefined {
  // Walk backward over whitespace.
  let end = position - 1;
  while (end >= 0 && /\s/.test(source[end] as string)) end -= 1;
  if (end < 1) return undefined;
  if (source[end] !== '/' || source[end - 1] !== '*') return undefined;
  // Scan back to the opening /**.
  let start = end - 2;
  while (start > 1 && !(source[start - 1] === '/' && source[start] === '*' && source[start + 1] === '*')) {
    start -= 1;
  }
  if (start <= 1) return undefined;
  const raw = source.slice(start - 1, end + 1);
  // Strip /** ... */ and leading `* ` from each line.
  const inner = raw
    .replace(/^\s*\/\*\*?/, '')
    .replace(/\*\/\s*$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
  return inner.length > 0 ? inner : undefined;
}

/**
 * Middleware identifiers the generator recognises, and which is the whole of
 * what it can reason about.
 *
 * The auth/authorization half is HAND-MAINTAINED, so a gate whose name is
 * missing from it is a gate this generator cannot see — and the spec then
 * publishes the route as needing no credential at all, which is the most
 * dangerous direction to be wrong in. Add every new auth/authorization
 * middleware here, and give it a case in `buildOperation`'s security block.
 *
 * The limiter half is a RULE rather than a list (`…Limiter` / `…RateLimit`),
 * because a missing limiter name costs only an undocumented 429 and a
 * hand-maintained list of them was already drifting.
 */
const MIDDLEWARE_TOKEN_RE =
  /\b(authMiddleware|emailCapabilityAuth|serviceAuthMiddleware|requireFirstPartyInferenceCaller|optionalAuthMiddleware|csrfProtection|requireOwnership|rejectServiceTokens|requireStaff|edgeGate|reportingPrincipal|providerConnectionPrincipal|routingPolicyPrincipal|mediaHeadersMiddleware|rateLimit|[A-Za-z0-9_]*(?:Limiter|RateLimit))\b/g;

function middlewareTokens(args: string): string[] {
  const found: string[] = [];
  const re = new RegExp(MIDDLEWARE_TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(args)) !== null) {
    const token = match[1];
    if (token && !found.includes(token)) found.push(token);
  }
  return found;
}

/**
 * A copy of the source with every comment's content replaced by spaces, byte for
 * byte, so an offset into the result is the same offset into the original.
 *
 * Everything that looks for CODE below scans this copy, because a census over
 * source that does not exclude comments measures the comments too. Measured:
 * `src/routes/accounts.ts:81` and `:114` both quote the literal text
 * `router.use(authMiddleware)` inside prose explaining why the routes above the
 * real gate are deliberately unauthenticated. Scanning the raw source finds two
 * phantom gates at those offsets and injects `authMiddleware` into the three
 * service-credential routes that sit between them and the real gate at `:314`.
 *
 * That did not corrupt the emitted document only because `serviceAuthMiddleware`
 * is evaluated before `authMiddleware` in the security block, so those three
 * routes published `serviceTokenAuth` either way. A genuinely public route below
 * such a comment would have been published as requiring a bearer — a claim about
 * a credential, invented by prose.
 *
 * Comments are blanked rather than removed so the JSDoc reader below can still
 * find the real comment above a route in the ORIGINAL source at the same offset.
 * Newlines are preserved for the same reason.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  let inStr: string | null = null;
  let inTemplate = false;
  while (i < source.length) {
    const ch = source[i];
    if (inStr !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (inTemplate) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') inTemplate = false;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const closed = source.indexOf('*/', i + 2);
      const stop = closed === -1 ? source.length : closed + 2;
      for (let j = i; j < stop; j += 1) out[j] = source[j] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Read the full argument list of a call whose opening paren has already been
 * consumed, using a balanced-parentheses walk that respects string and template
 * literals. Handler arguments contain whole function bodies, so counting parens
 * naively would stop in the middle of one.
 */
function readCallArgs(source: string, argsStart: number): string {
  let depth = 1;
  let i = argsStart;
  let inStr: string | null = null;
  let inTemplate = false;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (inStr) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
      }
      i += 1;
      continue;
    }
    if (inTemplate) {
      if (ch === '`') {
        inTemplate = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    i += 1;
  }
  return source.slice(argsStart, i - 1);
}

/**
 * The router-level gates a file installs with `router.use(...)`, each paired
 * with the offset it takes effect from.
 *
 * This exists because a `router.use(authMiddleware)` is INVISIBLE to a walker
 * that only reads `router.<verb>(...)` argument lists, and the consequence is
 * the worst-direction error the middleware whitelist below already warns about:
 * the generator sees no credential on the route and publishes it as public.
 * Measured on `main` before this change — every route in `devices.ts`,
 * `privacy.ts`, `email.ts`, `wallet.routes.ts`, `applications.ts` and nine more
 * files carries a router-level `authMiddleware` and was published with
 * `security: [{}]`.
 *
 * Express applies a pathless `use` only to what is registered AFTER it, and
 * several files rely on exactly that — `accounts.ts` registers its public
 * routes above `router.use(authMiddleware)` deliberately. So the offset is part
 * of the fact, not decoration. A PATH-SCOPED `router.use('/x', …)` is skipped
 * rather than guessed at: it gates a subtree this walker does not resolve, and
 * claiming a gate that may not apply is as wrong as missing one.
 */
function routerLevelGates(source: string): Array<{ from: number; middlewares: string[] }> {
  const gates: Array<{ from: number; middlewares: string[] }> = [];
  const useRe = /router\.use\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = useRe.exec(source)) !== null) {
    const args = readCallArgs(source, useRe.lastIndex);
    if (/^\s*['"`]/.test(args)) continue;
    const middlewares = middlewareTokens(args);
    if (middlewares.length > 0) gates.push({ from: useRe.lastIndex, middlewares });
  }
  return gates;
}

/**
 * The `@requestBody` declaration in a route's leading JSDoc, if it has one.
 *
 * ## Why a tag rather than moving the routes onto `validate({ body })`
 *
 * The generator reads request bodies out of `validate({ body })` middleware, and
 * the five `/v1` edge routes do not use it: they call
 * `<schema>.safeParse(req.body)` inside the handler (`routes/inferenceEdge.ts`),
 * so all five were published as taking an empty body. Two ways to close that, and
 * the choice is not stylistic.
 *
 * Moving them onto the middleware would CHANGE THE ERROR BODY of every validation
 * failure on the public edge, and measurably so. `middleware/validate` throws
 * `BadRequestError('Validation failed', { issues })`, which the global handler
 * serialises as the platform envelope. The edge answers something else on purpose:
 * `/v1/chat/completions` returns `{ error: { message, type, param, code } }`, which
 * is what a stock OpenAI client parses — asserted by
 * `routes/__tests__/inferenceEdge.test.ts:868` — and `/v1/responses` returns the
 * structured contract error carrying `requestId` and `retryable`, asserted at
 * `:1811`. Neither survives the move, and `requestId` on every error is one of the
 * three rules ADR 0010 fixes. Making the middleware reproduce both would mean
 * duplicating the edge's error mapper inside it, per route, which is more
 * behaviour change than the defect being fixed.
 *
 * So the generator is taught to read the schema instead. The tag names the same
 * identifier the handler calls `safeParse` on, resolved through the route file's
 * own imports, and an unresolvable one refuses the run — so the tag cannot rot
 * into naming a schema that no longer exists.
 *
 *     @requestBody chatCompletionsRequestSchema
 */
export function parseRequestBodyTag(jsdoc: string): string | undefined {
  for (const line of jsdoc.split(/\r?\n/)) {
    const match = /^\s*@requestBody\s+(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/**
 * The TOP-LEVEL entries of the first object literal in `source`, as raw text.
 *
 * The previous reader was `/validate\(\s*\{\s*([^}]+)\}\s*\)/` followed by
 * `body\s*:\s*([a-zA-Z0-9_]+)` per key, and both halves are wrong on real code.
 * `[^}]+` stops at the FIRST `}`, so
 * `validate({ params: routingPolicyParams, body: z.object({}).strict() })`
 * (`routes/inferenceRoutingPolicies.ts:580`) truncated to
 * `params: routingPolicyParams, body: z.object({`, and the identifier regex then
 * read the body schema's name as `z`. A depth-aware scan reads the whole entry
 * and hands back `z.object({}).strict()`, which `resolveRouteSchema` can then
 * refuse BY NAME instead of chasing a schema called `z`.
 *
 * Values are returned verbatim rather than as identifiers so an inline expression
 * stays visible: it is a schema the document would otherwise omit in silence, and
 * the refusal is the whole point.
 */
export function parseObjectLiteralEntries(source: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const open = source.indexOf('{');
  if (open === -1) return entries;

  let i = open + 1;
  let depth = 0;
  let inStr: string | null = null;
  let key: string | undefined;
  let valueStart = -1;

  const commit = (end: number): void => {
    if (key !== undefined) {
      // A shorthand entry (`{ body }`) has no colon, and its value is its key.
      const text = valueStart === -1 ? key : source.slice(valueStart, end).trim();
      if (text.length > 0) entries[key] = text;
    }
    key = undefined;
    valueStart = -1;
  };

  while (i < source.length) {
    const ch = source[i];
    if (inStr !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) {
        commit(i);
        break;
      }
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && ch === ':' && valueStart === -1) {
      valueStart = i + 1;
      i += 1;
      continue;
    }
    if (depth === 0 && ch === ',') {
      commit(i);
      i += 1;
      continue;
    }
    if (depth === 0 && valueStart === -1) {
      const identifier = /^[A-Za-z0-9_$]+/.exec(source.slice(i));
      if (identifier !== null && identifier[0] !== undefined) {
        key = identifier[0];
        i += identifier[0].length;
        continue;
      }
    }
    i += 1;
  }
  return entries;
}

/**
 * Read the `@response` declarations out of a route's leading JSDoc.
 *
 * ## Why the success response is declared and not inferred
 *
 * Every machine-derived operation in this document used to carry exactly
 * `responses['200'] = { description: 'Success' }` — 352 of 390 operations with no
 * success schema at all, while the 38 that had one all came from hand-written
 * `@openapi` blocks. A generated client therefore returned `Any` from every
 * endpoint the generator produced.
 *
 * Inferring the shape from the handler is not available: the bodies are built
 * inline at `res.json(...)` call sites, behind service calls, spreads and
 * conditionals, and a regex that guessed at them would publish a plausible
 * fiction. So the shape is DECLARED, in one line, beside the route — and bound to
 * the handler by the TYPE SYSTEM rather than by this comment: the handlers
 * annotate the body they send with the schema's own `z.infer` type, so a handler
 * that drifts from its declared schema fails `tsc`. A property enforced by the
 * type system needs its gate in the type system; this tag only carries the name
 * across to the document.
 *
 * ## Syntax
 *
 *     @response 200 responsesResponseSchema The completed generation.
 *     @response 200 application/octet-stream binary The audio bytes.
 *     @response 409 Error The requested state conflicts with current state.
 *
 * Two forms, told apart by whether the second token is a media type (contains a
 * `/`; a Zod identifier cannot). Media type defaults to `application/json`.
 * `binary` in the schema position emits `{ type: 'string', format: 'binary' }`,
 * which is how OpenAPI 3.1 spells a byte body.
 * `Error` names the shared `#/components/schemas/Error` envelope. Non-2xx
 * responses are emitted only when a route declares them; the generator never
 * infers a domain conflict such as 409 from handler prose or implementation.
 *
 * The identifier is resolved through the route file's OWN imports, exactly like a
 * `validate({ body })` reference, and an unresolvable one refuses the run rather
 * than dropping the response.
 */
export function parseResponseTags(jsdoc: string): ResponseTag[] {
  const tags: ResponseTag[] = [];
  for (const line of jsdoc.split(/\r?\n/)) {
    const match = /^\s*@response\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const status = match[1];
    const second = match[2];
    if (status === undefined || second === undefined) continue;
    const rest = (match[3] ?? '').trim();
    if (second.includes('/')) {
      const [schemaRef, ...descriptionWords] = rest.split(/\s+/);
      if (schemaRef === undefined || schemaRef.length === 0) continue;
      tags.push({
        status,
        mediaType: second,
        schemaRef,
        description: descriptionWords.join(' '),
      });
      continue;
    }
    tags.push({ status, mediaType: 'application/json', schemaRef: second, description: rest });
  }
  return tags;
}

/**
 * Parse all `router.<verb>(...)` calls in a single file. We use a regex to
 * find the call start and then a balanced-parentheses walker to capture the
 * full argument list, since handler arguments can include function
 * definitions with their own parens / strings.
 */
export function parseRoutesFromFile(source: string): Array<Omit<RouteEntry, 'mountPrefix' | 'filename'>> {
  const out: Array<Omit<RouteEntry, 'mountPrefix' | 'filename'>> = [];
  // Code is read from the comment-blanked copy, prose from the original. Offsets
  // are identical between the two by construction.
  const code = blankComments(source);
  const gates = routerLevelGates(code);
  const imports = parseImportBindings(code);
  const localConsts = parseLocalConstNames(code);
  const callRe = /router\.([a-zA-Z]+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(code)) !== null) {
    const verb = (match[1] ?? '').toLowerCase();
    if (!VERB_RE.test(verb)) continue;
    const argsStart = callRe.lastIndex;
    const args = readCallArgs(code, argsStart);

    // First argument: the path literal. Pull it out — first quoted token.
    const pathMatch = args.match(/^\s*['"`]([^'"`]+)['"`]/);
    if (!pathMatch || !pathMatch[1]) continue;
    const pathSuffix = pathMatch[1];

    // Identify validate({ body, params, query }) middleware.
    let validate: ValidateCall | undefined;
    const validateIdx = args.indexOf('validate(');
    if (validateIdx !== -1) {
      const entries = parseObjectLiteralEntries(
        readCallArgs(args, validateIdx + 'validate('.length)
      );
      validate = {
        body: entries.body,
        params: entries.params,
        query: entries.query,
      };
    }

    // Token-extract any middleware identifiers appearing before the handler
    // (used to infer required security: auth, csrf, ownership, etc.), then add
    // the router-level gates already in force at this point in the file.
    const middlewares = middlewareTokens(args);
    for (const gate of gates) {
      if (gate.from > argsStart) continue;
      for (const token of gate.middlewares) {
        if (!middlewares.includes(token)) middlewares.push(token);
      }
    }

    // Look for the leading JSDoc above the `router.<verb>(` token. The
    // generator only reuses comments that don't already contain `@openapi`,
    // because the JSDoc path is handled separately by swagger-jsdoc.
    const callStart = match.index;
    const jsdoc = findLeadingComment(source, callStart);
    const jsdocClean = jsdoc && !jsdoc.includes('@openapi') ? jsdoc : undefined;

    out.push({
      verb,
      pathSuffix,
      jsdoc: jsdocClean,
      validate,
      responseTags: jsdoc === undefined ? [] : parseResponseTags(jsdoc),
      requestBodyTag: jsdoc === undefined ? undefined : parseRequestBodyTag(jsdoc),
      imports,
      localConsts,
      middlewares,
    });
  }
  return out;
}

/**
 * Route entries in EXPRESS DISPATCH ORDER.
 *
 * Iterating `MOUNT_MAP`'s keys rather than the directory listing is what makes
 * the map's documented promise — "kept in sync with the order of `app.use(...)`
 * calls" — load-bearing instead of decorative. The synthesis below is first-wins
 * on `<VERB> <path>`, which is exactly how Express dispatches, so two routers
 * sharing a prefix resolve the way the server resolves them. Under a directory
 * listing the winner was whichever FILENAME sorted first, which is not a fact
 * about the server at all: `alia.ts` sorts before `inferenceEdge.ts`, so the
 * deprecated proxy would have taken `/v1/chat/completions` from the edge that
 * actually serves it, and published `serviceTokenAuth` where the real answer is a
 * machine credential.
 *
 * A mapped file that does not exist is a hard failure rather than a skip. That is
 * the `models-stats.ts` case: deleted in #982, its map entry left behind, and the
 * committed document went on describing `/models/stats` from it for a fortnight
 * because a missing file looked exactly like a file with no routes.
 */
async function extractRoutes(): Promise<RouteEntry[]> {
  const out: RouteEntry[] = [];
  const missing: string[] = [];
  for (const [basename, mountPrefixes] of Object.entries(MOUNT_MAP)) {
    const file = path.join(ROUTES_DIR, basename);
    if (!existsSync(file)) {
      missing.push(basename);
      continue;
    }
    const source = await readFile(file, 'utf8');
    const parsed = parseRoutesFromFile(source);
    for (const mountPrefix of mountPrefixes) {
      for (const route of parsed) {
        out.push({ ...route, mountPrefix, filename: basename });
      }
    }
  }
  if (missing.length > 0) {
    console.error(
      `\n[generate-openapi] MOUNT_MAP names ${missing.length} route file(s) that do not exist:\n` +
        `${missing.map((name) => `  - src/routes/${name}`).join('\n')}\n\n` +
        '  A stale entry is how a deleted route stays in the published contract. Remove\n' +
        '  the entry, or restore the file.\n'
    );
    process.exit(1);
  }
  return out;
}

function joinPath(mount: string, route: string): string {
  if (route === '/') return mount;
  return `${mount}${route}`.replace(/\/+/g, '/');
}

function expressPathToOpenApi(p: string): string {
  return p.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
}

function pathParamsFromExpress(p: string): string[] {
  const names: string[] = [];
  const re = /:([a-zA-Z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

/**
 * Summary/description from a leading JSDoc block. The first non-empty line
 * is the summary, the rest is the description. JSDoc-style tags (`@param`,
 * `@returns`, `@body`, `@query`, `@route`, `@desc`, `@access`) are stripped
 * because the parameters/security blocks already cover them; `@desc` /
 * `@description` content is folded into the description text instead.
 */
function splitJsdoc(jsdoc: string): { summary: string; description: string } {
  const rawLines = jsdoc.split(/\r?\n/);
  const filtered: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    // `@desc` / `@description` adds inline description content.
    const descMatch = trimmed.match(/^@(desc(?:ription)?)\s+(.*)$/i);
    if (descMatch && descMatch[2]) {
      filtered.push(descMatch[2]);
      continue;
    }
    // `@route` lines often hold the verb/path again — useful for sanity, but
    // they shouldn't show up in the description text. Drop them.
    if (trimmed.startsWith('@')) continue;
    filtered.push(line);
  }
  // First non-empty, non-route-marker line is the summary.
  let summary = '';
  const descLines: string[] = [];
  for (const line of filtered) {
    const trimmed = line.trim();
    if (!summary && (trimmed === '' || /^(GET|POST|PUT|DELETE|PATCH)\s+\//.test(trimmed))) {
      continue;
    }
    if (!summary) {
      summary = trimmed;
      continue;
    }
    descLines.push(line);
  }
  // Trim leading/trailing blank lines from the description.
  while (descLines.length && !descLines[0]?.trim()) descLines.shift();
  while (descLines.length && !descLines[descLines.length - 1]?.trim()) descLines.pop();
  const description = descLines.join('\n').trim();
  return {
    summary,
    description,
  };
}

/**
 * Resolve a schema identifier a route named, through that route's own imports.
 *
 * Every failure mode is RECORDED rather than returned as `undefined`-and-carry-on,
 * because carry-on is what published `/v1/chat/completions` as an endpoint taking
 * no body. The three reasons are distinguished so the message can say what to do:
 * an unimported identifier is a typo, a locally-declared one has to move into
 * `src/schemas/`, and a non-Zod export means the wrong name was written down.
 */
function resolveRouteSchema(route: RouteEntry, reference: string): ZodTypeAny | undefined {
  if (!/^[A-Za-z0-9_$]+$/.test(reference)) {
    // An inline expression — `body: z.object({}).strict()`. Recorded rather than
    // ignored: it is a real schema the operation would otherwise be published
    // without, and naming it in src/schemas/ is a one-line move.
    unresolvedSchemaReferences.push({
      filename: route.filename,
      identifier: reference,
      reason:
        'is an inline schema expression rather than a named import, so it cannot be resolved '
        + 'without executing the router. Name it in src/schemas/<name>.schemas.ts and import it.',
    });
    return undefined;
  }
  const identifier = reference;
  const specifier = route.imports[identifier];
  if (specifier === undefined) {
    unresolvedSchemaReferences.push({
      filename: route.filename,
      identifier,
      reason: route.localConsts.includes(identifier)
        ? 'declared locally in the route file, so it cannot be imported without executing the '
          + 'router. Move it into src/schemas/<name>.schemas.ts and import it.'
        : 'not imported by this route file.',
    });
    return undefined;
  }

  const moduleSpecifier = schemaModuleSpecifier(specifier);
  if (moduleSpecifier === undefined) {
    unresolvedSchemaReferences.push({
      filename: route.filename,
      identifier,
      reason: `imported from "${specifier}", which this generator will not import. Schemas must `
        + 'come from ../schemas/* or @oxyhq/contracts.',
    });
    return undefined;
  }

  const value = loadedSchemaModules.get(moduleSpecifier)?.[identifier];
  if (!isZodSchema(value)) {
    unresolvedSchemaReferences.push({
      filename: route.filename,
      identifier,
      reason:
        value === undefined
          ? `not exported by "${specifier}".`
          : `exported by "${specifier}" but is not a Zod schema.`,
    });
    return undefined;
  }
  return value;
}

interface BuildOperationInput {
  route: RouteEntry;
  openApiPath: string;
}

/**
 * Build an OpenAPI operation object for a route entry. Synthesises
 * descriptions, request body, parameters, and responses with sensible
 * defaults based on the route's middleware and validate calls.
 */
export function buildOperation({ route, openApiPath }: BuildOperationInput): OpenApiOperation {
  const tag = TAG_GROUPS[route.mountPrefix] ?? 'Misc';
  const { jsdoc, validate, middlewares, verb } = route;

  let summary = `${verb.toUpperCase()} ${openApiPath}`;
  let description = '';

  if (jsdoc) {
    const split = splitJsdoc(jsdoc);
    if (split.summary) summary = split.summary;
    if (split.description) description = split.description;
  }
  // If we have no useful description, fall back to a stub note that tells
  // engineers to add a JSDoc comment.
  if (!description) {
    description = `No long-form description. Add a JSDoc block (or \`@openapi\` block) above this route in \`src/routes/${route.filename}\` to fill in summary, description, request/response examples.`;
  }

  // Path parameters always come from the Express pattern. Query/params Zod
  // schemas override the inferred string type with a proper schema.
  const pathParamNames = pathParamsFromExpress(joinPath(route.mountPrefix, route.pathSuffix));
  const parameters: Record<string, unknown>[] = [];

  const paramsSchema = validate?.params ? resolveRouteSchema(route, validate.params) : undefined;
  const paramsOpenApi = paramsSchema ? zodToOpenApi(paramsSchema) : undefined;
  const paramsProps = (paramsOpenApi?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const paramsRequired = new Set<string>(((paramsOpenApi?.required ?? []) as string[]) ?? []);

  for (const name of pathParamNames) {
    const schema = paramsProps[name] ?? { type: 'string' };
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema,
    });
  }

  // Query parameters come from the query Zod schema if present.
  const querySchema = validate?.query ? resolveRouteSchema(route, validate.query) : undefined;
  if (querySchema) {
    const queryOpenApi = zodToOpenApi(querySchema);
    const queryProps = (queryOpenApi.properties ?? {}) as Record<string, Record<string, unknown>>;
    const queryRequired = new Set<string>(((queryOpenApi.required ?? []) as string[]) ?? []);
    for (const [name, schema] of Object.entries(queryProps)) {
      parameters.push({
        name,
        in: 'query',
        required: queryRequired.has(name),
        schema,
      });
    }
  }

  // Body Zod schema, from the `validate({ body })` middleware or from an
  // `@requestBody` tag on a route that validates inside its handler instead.
  let requestBody: Record<string, unknown> | undefined;
  if (validate?.body !== undefined && route.requestBodyTag !== undefined) {
    // Two authorities for one fact. Refused rather than silently preferring one,
    // because whichever this picked would be right until somebody edited the other.
    unresolvedSchemaReferences.push({
      filename: route.filename,
      identifier: route.requestBodyTag,
      reason:
        `${route.verb.toUpperCase()} ${openApiPath} declares an @requestBody tag AND a `
        + 'validate({ body }) middleware. Keep the middleware and delete the tag — the tag is '
        + 'only for routes that validate inside the handler.',
    });
  }
  const bodyReference = validate?.body ?? route.requestBodyTag;
  if (bodyReference !== undefined) {
    const bodySchema = resolveRouteSchema(route, bodyReference);
    if (bodySchema) {
      requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: zodToOpenApi(bodySchema),
          },
        },
      };
    }
  }

  // Security inference.
  const security: Array<Record<string, string[]>> = [];
  // General service-only gates mean no user bearer reaches this route.
  const isServiceOnly = middlewares.includes('serviceAuthMiddleware');
  // The public inference edge (`routes/inferenceEdge.ts`): `edgeGate` calls
  // `authenticateEdgeCaller`, which accepts an `oxy_sk_…` machine credential or
  // a first-party service token, and nothing else — a user session bearer is
  // refused, so `bearerAuth` would be the wrong scheme to publish here.
  const isEdgeCredential = middlewares.includes('edgeGate');
  // The inference control-plane routers install one `…Principal` gate at router
  // level that takes a service token when the bearer verifies as one and falls
  // back to the user session lane otherwise. Both are genuinely accepted, so
  // both are published as alternatives.
  const isDualPrincipal = middlewares.some(
    (m) =>
      m === 'reportingPrincipal' ||
      m === 'providerConnectionPrincipal' ||
      m === 'routingPolicyPrincipal'
  );
  // Inbox accepts either the user's normal bearer session or a short-lived,
  // audience-bound capability ticket. `emailCapabilityAuth` selects the lane
  // from the Authorization scheme and never treats a Capability ticket as a
  // general user session.
  const isEmailCapability = middlewares.includes('emailCapabilityAuth');
  const acceptsCapabilityTicket =
    isEmailCapability &&
    INBOX_CAPABILITY_CATALOG.tools.some(
      (tool) => tool.invocation.method === verb.toUpperCase() && tool.invocation.path === openApiPath,
    );
  const isAuth = middlewares.includes('authMiddleware');
  const isOptionalAuth = middlewares.includes('optionalAuthMiddleware');
  if (isEdgeCredential) {
    security.push({ machineCredentialAuth: [] });
    security.push({ serviceTokenAuth: [] });
  } else if (isDualPrincipal) {
    security.push({ serviceTokenAuth: [] });
    security.push({ bearerAuth: [] });
  } else if (isServiceOnly) {
    security.push({ serviceTokenAuth: [] });
  } else if (acceptsCapabilityTicket) {
    security.push({ capabilityTicketAuth: [] });
    security.push({ bearerAuth: [] });
  } else if (isEmailCapability) {
    security.push({ bearerAuth: [] });
  } else if (isAuth) {
    security.push({ bearerAuth: [] });
  } else if (isOptionalAuth) {
    security.push({ bearerAuth: [] });
    security.push({});
  } else {
    security.push({});
  }
  const requiresCredential =
    isEdgeCredential || isDualPrincipal || isServiceOnly || isEmailCapability || isAuth;

  // CSRF — if the route file is mounted with csrfProtection at the server
  // level we don't add it again per-op. The base spec documents the header
  // policy globally.

  // Responses.
  //
  // Every explicitly declared response comes from the route's own `@response`
  // tags. Without a 2xx declaration the operation falls back to a bare
  // `{ description }`, which is what EVERY machine-derived operation carried
  // before this: 352 of 390
  // operations published with no success schema, so a generated client returned
  // `Any` from all of them. The fallback still exists because 300-odd operations
  // are not going to be annotated in one change — but the fallback now says so in
  // words a reader of the contract can act on, instead of the word "Success".
  const responses: Record<string, unknown> = {};
  const successTags = route.responseTags.filter((tag) => tag.status.startsWith('2'));
  for (const tag of route.responseTags) {
    let schema: Record<string, unknown>;
    if (tag.schemaRef === 'binary') {
      schema = { type: 'string', format: 'binary' };
    } else if (tag.schemaRef === 'Error') {
      schema = { $ref: '#/components/schemas/Error' };
    } else {
      const resolved = resolveRouteSchema(route, tag.schemaRef);
      schema = resolved === undefined ? {} : zodToOpenApi(resolved);
    }
    responses[tag.status] = {
      description:
        tag.description.length > 0
          ? tag.description
          : tag.status.startsWith('2')
            ? 'Success'
            : `HTTP ${tag.status}`,
      content: { [tag.mediaType]: { schema } },
    };
  }
  if (successTags.length === 0) {
    responses['200'] = {
      description:
        'Success. The response body is not described — add an `@response <code> <schemaIdentifier>` '
        + `line to the JSDoc above this route in \`src/routes/${route.filename}\`, naming a Zod `
        + 'schema the file imports.',
    };
  }
  if (requestBody || parameters.some((p) => p.in === 'path' || p.in === 'query')) {
    responses['400'] ??= {
      description: 'Validation failed',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (requiresCredential) {
    responses['401'] ??= {
      description: 'Authentication required',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (
    middlewares.includes('requireOwnership') ||
    middlewares.includes('requireStaff') ||
    isServiceOnly ||
    isDualPrincipal ||
    acceptsCapabilityTicket
  ) {
    responses['403'] ??= {
      description: 'Insufficient privileges',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (pathParamNames.length > 0) {
    responses['404'] ??= {
      description: 'Resource not found',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (middlewares.some((m) => m === 'rateLimit' || /(?:Limiter|RateLimit)$/.test(m))) {
    responses['429'] ??= {
      description: 'Rate limit exceeded',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  responses['5XX'] ??= {
    description: 'Server error',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };

  const op: OpenApiOperation = {
    tags: [tag],
    summary,
    description,
    parameters,
    responses,
    security,
  };
  if (requestBody) op.requestBody = requestBody;
  return op;
}

/* ----------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  if (!existsSync(BASE_YAML)) {
    console.error(`[generate-openapi] missing ${BASE_YAML}`);
    process.exit(1);
  }

  const baseDoc = parseYaml(await readFile(BASE_YAML, 'utf8'));
  if (!baseDoc.paths) baseDoc.paths = {};

  // Pull JSDoc-annotated paths via swagger-jsdoc. These take precedence over
  // anything the route walker would synthesise.
  const jsdocSpec = swaggerJsdoc({
    definition: {
      openapi: baseDoc.openapi ?? '3.0.0',
      info: baseDoc.info,
      servers: baseDoc.servers ?? [],
      components: baseDoc.components ?? {},
    },
    apis: [path.join(ROUTES_DIR, '*.ts')],
  }) as OpenApiDocument;

  const documented = jsdocSpec.paths ?? {};

  // Walk the routers to find any endpoint that the JSDoc scan missed.
  const routes = await extractRoutes();

  // Pre-load exactly the modules the routes' own schema references reach, so the
  // per-operation lookups below can be synchronous. Narrowed to referenced
  // identifiers rather than "every ../schemas/* import": a route file imports its
  // services and middleware too, and importing those to look for a Zod schema
  // would execute code for no possible gain.
  const neededSpecifiers = new Set<string>();
  for (const route of routes) {
    const identifiers = [
      route.validate?.body,
      route.validate?.params,
      route.validate?.query,
      route.requestBodyTag,
      ...route.responseTags.map((tag) => tag.schemaRef),
    ];
    for (const identifier of identifiers) {
      if (identifier === undefined || identifier === 'binary') continue;
      const specifier = route.imports[identifier];
      if (specifier === undefined) continue;
      const moduleSpecifier = schemaModuleSpecifier(specifier);
      if (moduleSpecifier !== undefined) neededSpecifiers.add(moduleSpecifier);
    }
  }
  for (const specifier of [...neededSpecifiers].sort()) {
    // eslint-disable-next-line no-await-in-loop
    await loadSchemaModule(specifier);
  }
  const seen = new Set<string>();
  for (const [pathKey, methods] of Object.entries(documented)) {
    for (const method of Object.keys(methods)) {
      seen.add(`${method.toUpperCase()} ${pathKey}`);
    }
  }

  for (const route of routes) {
    const fullExpressPath = joinPath(route.mountPrefix, route.pathSuffix);
    const openApiPath = expressPathToOpenApi(fullExpressPath);
    const key = `${route.verb.toUpperCase()} ${openApiPath}`;
    if (seen.has(key)) continue;
    const op = buildOperation({ route, openApiPath });
    if (!documented[openApiPath]) documented[openApiPath] = {};
    documented[openApiPath][route.verb.toLowerCase()] = op;
    seen.add(key);
  }

  // An `operationId` for every operation that does not already declare one.
  //
  // This is how a generator NAMES the function it emits. With none — 0 of 390
  // before this — every mainstream generator falls back to inventing one from the
  // verb and path, and each invents a different one, so the client's API changes
  // shape when the generator is upgraded. The value is derived deterministically
  // from `<verb> <path>` and is therefore stable across runs, but it is written
  // into the document so that stability is a promise the contract makes rather
  // than a property of whichever tool read it.
  //
  // Hand-written `@openapi` blocks win: a curated id is a deliberate name for a
  // published function, and overwriting it would rename somebody's client method.
  const operationIds = new Map<string, string>();
  for (const [pathKey, methods] of Object.entries(documented)) {
    for (const [verb, operation] of Object.entries(methods)) {
      // A path item may legitimately hold non-operation keys (`parameters`,
      // `summary`), and one of those is not an operation to name.
      if (!VERB_RE.test(verb)) continue;
      const existing = operation.operationId;
      const operationId =
        typeof existing === 'string' && existing.length > 0
          ? existing
          : `${verb.toLowerCase()}${pathKey
              .split(/[^A-Za-z0-9]+/)
              .filter((segment) => segment.length > 0)
              .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
              .join('')}`;
      const collision = operationIds.get(operationId);
      if (collision !== undefined) {
        // A duplicate `operationId` is invalid OpenAPI and makes a generator emit
        // two methods with one name — one of which silently wins. Asserted rather
        // than deduplicated with a suffix, because a suffix would move the
        // ambiguity into the client's method names instead of removing it.
        console.error(
          `\n[generate-openapi] REFUSING TO WRITE: operationId "${operationId}" is claimed by both `
          + `${collision} and ${verb.toUpperCase()} ${pathKey}.\n\n`
          + '  Two operations with one id is invalid OpenAPI, and a generated client would emit\n'
          + '  two methods with the same name. Give one of them an explicit `operationId` in an\n'
          + '  `@openapi` block.\n'
        );
        process.exit(1);
      }
      operationIds.set(operationId, `${verb.toUpperCase()} ${pathKey}`);
      operation.operationId = operationId;
    }
  }

  // Paths sorted, so the output is DETERMINISTIC. They were previously emitted
  // in route-walk order, which depends on directory listing and on where each
  // handler sits in its file — so an unrelated edit reshuffled the document and
  // produced a diff in the tens of thousands of lines with a few hundred lines
  // of actual change inside it. Measured on the regeneration this commit ships:
  // 15,403 textual diff lines against 803 semantic ones.
  //
  // That is not cosmetic. An unreviewable diff is precisely how contract drift
  // accumulates unnoticed — nobody reads 15,000 lines to find the nine routes
  // that appeared, so nobody notices the description that silently went wrong.
  const sortedPaths: typeof documented = {};
  for (const route of Object.keys(documented).sort()) {
    sortedPaths[route] = documented[route] as (typeof documented)[string];
  }

  const merged: OpenApiDocument = {
    openapi: baseDoc.openapi ?? '3.1.0',
    info: baseDoc.info,
    servers: baseDoc.servers ?? [],
    components: { ...(baseDoc.components ?? {}), ...(jsdocSpec.components ?? {}) },
    paths: sortedPaths,
    tags: baseDoc.tags ?? [],
  };

  if (baseDoc.security) merged.security = baseDoc.security;

  // REFUSE TO WRITE on a partial read. Everything above this point succeeded,
  // which is exactly why it has to be checked here: the merged document looks
  // perfectly well-formed and is simply missing whatever those modules export.
  if (schemaImportFailures.length > 0) {
    console.error(
      `\n[generate-openapi] REFUSING TO WRITE: ${schemaImportFailures.length} schema module(s) `
      + 'could not be imported, so the document would be missing their schemas.\n',
    );
    for (const { filename, error } of schemaImportFailures) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`  ${filename}\n    ${detail.split('\n')[0]}\n`);
    }
    console.error(
      '  The usual cause is unbuilt workspace dependencies — these modules import\n'
      + '  `@oxyhq/contracts` and `@oxyhq/db`, which resolve through their build output.\n'
      + '  Build them first, from the repository root (this is the same sequence\n'
      + '  `ci.yml` runs before the api tests, for the same reason):\n\n'
      + '      bun run --filter @oxyhq/contracts build\n'
      + '      bun run --filter @oxyhq/protocol build\n'
      + '      bun run --filter @oxyhq/core build\n'
      + '      bun run --filter @oxyhq/db build\n\n'
      + `  ${OUTPUT_JSON} is UNCHANGED. The previous document is still the committed\n`
      + '  contract, which is the correct outcome: a stale document is recoverable,\n'
      + '  a silently truncated one that ships to consumers is not.\n',
    );
    process.exit(1);
  }

  // Same refusal, for a Zod type the converter has no case for. It would have
  // been published as `{}` — "any value is acceptable" — which is a claim, not a
  // gap, and one no consumer can tell apart from a deliberate `z.unknown()`.
  if (unconvertibleZodTypes.length > 0) {
    console.error(
      `\n[generate-openapi] REFUSING TO WRITE: ${unconvertibleZodTypes.length} Zod type(s) have no `
      + 'case in `zodToOpenApi`, so their schemas would be published as `{}`:\n'
      + `${unconvertibleZodTypes.map((name) => `  - ${name}`).join('\n')}\n\n`
      + '  `{}` is a VALID OpenAPI schema meaning "any value is acceptable", so the document\n'
      + '  would read as a considered decision to accept anything. Add a case to\n'
      + '  `zodToOpenApi` in this file. `ZodAny` and `ZodUnknown` are the only two types for\n'
      + `  which \`{}\` is the truth.\n\n  ${OUTPUT_JSON} is UNCHANGED.\n`,
    );
    process.exit(1);
  }

  // Same refusal, for a schema a route names but that could not be resolved. The
  // operation would have been published with no request body and no query
  // parameters — a contract saying the endpoint takes nothing, from a route that
  // validates and rejects.
  if (unresolvedSchemaReferences.length > 0) {
    console.error(
      `\n[generate-openapi] REFUSING TO WRITE: ${unresolvedSchemaReferences.length} schema `
      + 'reference(s) could not be resolved, so their operations would be published as taking\n'
      + 'no body and no parameters:\n',
    );
    for (const { filename, identifier, reason } of unresolvedSchemaReferences) {
      console.error(`  src/routes/${filename} → ${identifier}\n    ${reason}\n`);
    }
    console.error(
      '  Schemas are resolved through the route file\'s OWN import statements, from\n'
      + '  ../schemas/* or @oxyhq/contracts. Nothing else is imported, because a route file\n'
      + '  also imports its services and middleware.\n\n'
      + `  ${OUTPUT_JSON} is UNCHANGED.\n`,
    );
    process.exit(1);
  }

  await writeFile(OUTPUT_JSON, JSON.stringify(merged, null, 2));
  const totalOps = Object.values(merged.paths).reduce(
    (acc, methods) => acc + Object.keys(methods).length,
    0,
  );
  console.error(
    `[generate-openapi] wrote ${OUTPUT_JSON} with ${Object.keys(merged.paths).length} paths, ${totalOps} operations.`,
  );
}

// Guarded so the parser can be imported by a test without running a generation.
// Bun/CommonJS: `require.main` is this module only when it was the entrypoint.
if (require.main === module) {
  main().catch((err) => {
    console.error('[generate-openapi] fatal:', err);
    process.exit(1);
  });
}
