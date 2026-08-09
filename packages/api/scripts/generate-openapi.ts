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
 *          `authMiddleware`, serviceTokenAuth for `serviceAuthMiddleware`)
 *        * applies the standard error envelope for 4xx/5xx responses.
 *   4. Write the merged document to `packages/api/openapi.json` so the website
 *      sync step can copy it via `git show <ref>:openapi.json`.
 *
 * The route walker is intentionally regex-based — it doesn't need a full TS
 * parser, but it does need to recognise the conventions the route files
 * actually use today. Update `MOUNT_MAP`, `TAG_GROUPS`, and the Zod schema
 * loader when extending the API.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import swaggerJsdoc from 'swagger-jsdoc';
import { z, ZodTypeAny } from 'zod';

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
function zodToOpenApi(schema: ZodTypeAny): Record<string, unknown> {
  if (!schema || typeof (schema as { _def?: unknown })._def !== 'object') {
    return { type: 'string' };
  }
  const def = (schema as { _def: { typeName?: string; [key: string]: unknown } })._def;
  const typeName = def.typeName ?? '';

  switch (typeName) {
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; regex?: RegExp; message?: string }>;
      for (const c of checks) {
        if (c.kind === 'min' && typeof c.value === 'number') out.minLength = c.value;
        if (c.kind === 'max' && typeof c.value === 'number') out.maxLength = c.value;
        if (c.kind === 'email') out.format = 'email';
        if (c.kind === 'url') out.format = 'uri';
        if (c.kind === 'uuid') out.format = 'uuid';
        if (c.kind === 'cuid' || c.kind === 'cuid2') out.format = c.kind;
        if (c.kind === 'datetime') out.format = 'date-time';
        if (c.kind === 'regex' && c.regex instanceof RegExp) out.pattern = c.regex.source;
        if (c.kind === 'length' && typeof c.value === 'number') {
          out.minLength = c.value;
          out.maxLength = c.value;
        }
      }
      return out;
    }
    case 'ZodNumber': {
      const out: Record<string, unknown> = { type: 'number' };
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; inclusive?: boolean }>;
      for (const c of checks) {
        if (c.kind === 'int') out.type = 'integer';
        if (c.kind === 'min' && typeof c.value === 'number') {
          out.minimum = c.value;
          if (c.inclusive === false) out.exclusiveMinimum = true;
        }
        if (c.kind === 'max' && typeof c.value === 'number') {
          out.maximum = c.value;
          if (c.inclusive === false) out.exclusiveMaximum = true;
        }
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
      return { ...inner, nullable: true };
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
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    default:
      return {};
  }
}

/**
 * Load a schema module from `src/schemas/<file>.schemas.ts`. The schemas are
 * already plain Zod objects so we can import them at generation time and
 * convert. Returns `{}` if the file can't be loaded so the generator continues
 * with a stub.
 */
async function loadSchemaModule(filename: string): Promise<Record<string, ZodTypeAny>> {
  const full = path.join(SCHEMAS_DIR, filename);
  if (!existsSync(full)) return {};
  try {
    const mod = await import(full);
    return mod as Record<string, ZodTypeAny>;
  } catch (err) {
    // Recorded rather than swallowed. Continuing past a failed import is
    // deliberate — one run should name EVERY unimportable module rather than
    // stopping at the first — but the run must not then write a document, and
    // `schemaImportFailures` is what makes that impossible to forget.
    schemaImportFailures.push({ filename, error: err });
    return {};
  }
}

/* ----------------------- route walker (stub gen) --------------------- */

interface ValidateCall {
  body?: string;
  params?: string;
  query?: string;
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
  /** Middleware tokens applied between the path and handler. */
  middlewares: string[];
}

/**
 * Mount map: route file basename → Express mount prefix (from `server.ts`).
 * Kept in sync with the order of `app.use(...)` calls.
 */
const MOUNT_MAP: Record<string, string> = {
  'auth.ts': '/auth',
  'authLinking.ts': '/auth',
  'assets.ts': '/assets',
  'cdn.ts': '/cdn',
  'storage.ts': '/storage',
  'search.ts': '/search',
  'profiles.ts': '/profiles',
  'users.ts': '/users',
  'userData.ts': '/users/me/app-data',
  'sessionDevice.ts': '/session/device',
  'session.ts': '/session',
  'privacy.ts': '/privacy',
  'analytics.routes.ts': '/analytics',
  'payment.routes.ts': '/payments',
  'notifications.routes.ts': '/notifications',
  'reputation.routes.ts': '/reputation',
  'wallet.routes.ts': '/wallet',
  'linkMetadata.ts': '/link-metadata',
  'links.ts': '/links',
  'locationSearch.ts': '/location-search',
  'applications.ts': '/applications',
  'accounts.ts': '/accounts',
  'devices.ts': '/devices',
  'security.ts': '/security',
  'subscription.routes.ts': '/subscription',
  'emailProxy.ts': '/email/proxy',
  'emailInbound.ts': '/email/inbound',
  'email.ts': '/email',
  'alia.ts': '/alia',
  'credits.ts': '/credits',
  'billing.ts': '/billing',
  'models-stats.ts': '/models',
  'platform-stats.ts': '/platform-stats',
  'topics.routes.ts': '/topics',
  'contacts.ts': '/contacts',
  'socialAuth.ts': '/auth/social',
  'appSignals.ts': '/app-signals',
  'identity.ts': '/identity',
  'civic.ts': '/civic',
  'nodes.ts': '/nodes',
  'federation.ts': '/federation',
  'did.ts': '/',
};

/**
 * Human-friendly tag for each mount prefix. Mirrors the `tags` block in
 * `openapi.base.yaml`.
 */
const TAG_GROUPS: Record<string, string> = {
  '/auth': 'Authentication',
  '/auth/social': 'Authentication',
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
  '/alia': 'AI',
  '/credits': 'Credits',
  '/billing': 'Billing',
  '/models': 'AI',
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
 * Map a route file basename to the schemas module that the file imports.
 * Mirrors the `import { ... } from '../schemas/...'` lines in each route file.
 */
const SCHEMA_MODULE_MAP: Record<string, string> = {
  'auth.ts': 'auth.schemas.ts',
  'authLinking.ts': 'authLinking.schemas.ts',
  'assets.ts': 'assets.schemas.ts',
  'contacts.ts': 'contacts.schemas.ts',
  'credits.ts': 'credits.schemas.ts',
  'applications.ts': 'application.schemas.ts',
  'devices.ts': 'devices.schemas.ts',
  'email.ts': 'email.schemas.ts',
  'reputation.routes.ts': 'reputation.schemas.ts',
  'notifications.routes.ts': 'notifications.schemas.ts',
  'privacy.ts': 'privacy.schemas.ts',
  'profiles.ts': 'profiles.schemas.ts',
  'search.ts': 'search.schemas.ts',
  'security.ts': 'security.schemas.ts',
  'session.ts': 'session.schemas.ts',
  'socialAuth.ts': 'socialAuth.schemas.ts',
  'subscription.routes.ts': 'subscription.schemas.ts',
  'users.ts': 'users.schemas.ts',
  'wallet.routes.ts': 'wallet.schemas.ts',
  'billing.ts': 'billing.schemas.ts',
};

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
 * Parse all `router.<verb>(...)` calls in a single file. We use a regex to
 * find the call start and then a balanced-parentheses walker to capture the
 * full argument list, since handler arguments can include function
 * definitions with their own parens / strings.
 */
function parseRoutesFromFile(source: string): Array<Omit<RouteEntry, 'mountPrefix' | 'filename'>> {
  const out: Array<Omit<RouteEntry, 'mountPrefix' | 'filename'>> = [];
  const callRe = /router\.([a-zA-Z]+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(source)) !== null) {
    const verb = (match[1] ?? '').toLowerCase();
    if (!VERB_RE.test(verb)) continue;
    const argsStart = callRe.lastIndex;
    // Walk forward to find the matching close paren.
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
    const argsEnd = i - 1;
    const args = source.slice(argsStart, argsEnd);

    // First argument: the path literal. Pull it out — first quoted token.
    const pathMatch = args.match(/^\s*['"`]([^'"`]+)['"`]/);
    if (!pathMatch || !pathMatch[1]) continue;
    const pathSuffix = pathMatch[1];

    // Identify validate({ body, params, query }) middleware. Use a non-greedy
    // capture of the call inside.
    let validate: ValidateCall | undefined;
    const validateMatch = args.match(/validate\(\s*\{\s*([^}]+)\}\s*\)/);
    if (validateMatch && validateMatch[1]) {
      const inner = validateMatch[1];
      const bodyRef = inner.match(/body\s*:\s*([a-zA-Z0-9_]+)/);
      const paramsRef = inner.match(/params\s*:\s*([a-zA-Z0-9_]+)/);
      const queryRef = inner.match(/query\s*:\s*([a-zA-Z0-9_]+)/);
      validate = {
        body: bodyRef?.[1],
        params: paramsRef?.[1],
        query: queryRef?.[1],
      };
    }

    // Token-extract any middleware identifiers appearing before the handler
    // (used to infer required security: auth, csrf, ownership, etc.).
    const middlewares: string[] = [];
    const mwRe = /\b(authMiddleware|serviceAuthMiddleware|optionalAuthMiddleware|csrfProtection|requireOwnership|rejectServiceTokens|rateLimit|userRateLimiter|authRateLimiter|challengeLimiter|verifyLimiter|checkLimiter|serviceTokenLimiter|discoverLimiter|webhookLimiter|mediaHeadersMiddleware)\b/g;
    let mwMatch: RegExpExecArray | null;
    while ((mwMatch = mwRe.exec(args)) !== null) {
      const token = mwMatch[1];
      if (token && !middlewares.includes(token)) middlewares.push(token);
    }

    // Look for the leading JSDoc above the `router.<verb>(` token. The
    // generator only reuses comments that don't already contain `@openapi`,
    // because the JSDoc path is handled separately by swagger-jsdoc.
    const callStart = match.index;
    const jsdoc = findLeadingComment(source, callStart);
    const jsdocClean = jsdoc && !jsdoc.includes('@openapi') ? jsdoc : undefined;

    out.push({ verb, pathSuffix, jsdoc: jsdocClean, validate, middlewares });
  }
  return out;
}

async function listRouteFiles(): Promise<string[]> {
  if (!existsSync(ROUTES_DIR)) return [];
  const entries = await readdir(ROUTES_DIR);
  return entries
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(ROUTES_DIR, f));
}

async function extractRoutes(): Promise<RouteEntry[]> {
  const files = await listRouteFiles();
  const out: RouteEntry[] = [];
  for (const file of files) {
    const basename = path.basename(file);
    const mountPrefix = MOUNT_MAP[basename];
    if (!mountPrefix) continue;
    const source = await readFile(file, 'utf8');
    const parsed = parseRoutesFromFile(source);
    for (const route of parsed) {
      out.push({ ...route, mountPrefix, filename: basename });
    }
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

interface BuildOperationInput {
  route: RouteEntry;
  schemaModule: Record<string, ZodTypeAny>;
  openApiPath: string;
}

/**
 * Build an OpenAPI operation object for a route entry. Synthesises
 * descriptions, request body, parameters, and responses with sensible
 * defaults based on the route's middleware and validate calls.
 */
function buildOperation({ route, schemaModule, openApiPath }: BuildOperationInput): OpenApiOperation {
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

  const paramsSchema = validate?.params ? schemaModule[validate.params] : undefined;
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
  const querySchema = validate?.query ? schemaModule[validate.query] : undefined;
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

  // Body Zod schema.
  let requestBody: Record<string, unknown> | undefined;
  if (validate?.body) {
    const bodySchema = schemaModule[validate.body];
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
  const isServiceOnly = middlewares.includes('serviceAuthMiddleware');
  const isAuth = middlewares.includes('authMiddleware');
  const isOptionalAuth = middlewares.includes('optionalAuthMiddleware');
  if (isServiceOnly) {
    security.push({ serviceTokenAuth: [] });
  } else if (isAuth) {
    security.push({ bearerAuth: [] });
  } else if (isOptionalAuth) {
    security.push({ bearerAuth: [] });
    security.push({});
  } else {
    security.push({});
  }

  // CSRF — if the route file is mounted with csrfProtection at the server
  // level we don't add it again per-op. The base spec documents the header
  // policy globally.

  // Responses.
  const responses: Record<string, unknown> = {
    '200': { description: 'Success' },
  };
  if (requestBody || parameters.some((p) => p.in === 'path' || p.in === 'query')) {
    responses['400'] = {
      description: 'Validation failed',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (isServiceOnly || isAuth) {
    responses['401'] = {
      description: 'Authentication required',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (middlewares.includes('requireOwnership') || isServiceOnly) {
    responses['403'] = {
      description: 'Insufficient privileges',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (pathParamNames.length > 0) {
    responses['404'] = {
      description: 'Resource not found',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  if (middlewares.some((m) => m.endsWith('Limiter') || m === 'rateLimit' || m === 'userRateLimiter' || m === 'authRateLimiter')) {
    responses['429'] = {
      description: 'Rate limit exceeded',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  responses['5XX'] = {
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

  // Pre-load every schema module up front so we can do sync lookups while
  // emitting operations.
  const schemaCache: Record<string, Record<string, ZodTypeAny>> = {};
  for (const [routeFile, schemaFile] of Object.entries(SCHEMA_MODULE_MAP)) {
    if (!schemaCache[routeFile]) {
      // eslint-disable-next-line no-await-in-loop
      schemaCache[routeFile] = await loadSchemaModule(schemaFile);
    }
  }

  // Walk the routers to find any endpoint that the JSDoc scan missed.
  const routes = await extractRoutes();
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
    const schemaModule = schemaCache[route.filename] ?? {};
    const op = buildOperation({ route, schemaModule, openApiPath });
    if (!documented[openApiPath]) documented[openApiPath] = {};
    documented[openApiPath][route.verb.toLowerCase()] = op;
    seen.add(key);
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
