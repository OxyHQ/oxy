/**
 * How a catalog tool call travels over HTTP, in both directions.
 *
 * A capability catalog names each tool's `invocation` as a method plus a path
 * template (`/email/messages/{emailId}`). Two parties have to agree on what
 * that means: the coordinator that BUILDS the request from the model's
 * arguments (Alia), and the app that MATCHES an incoming request back to the
 * one tool its ticket was signed for (the Inbox capability middleware). Each
 * used to carry its own copy of the rules, and the matcher walked the tool list
 * in array order, so a literal segment (`/messages/unread`) and a parameter
 * (`/messages/{id}`) in the same position resolved to whichever tool happened to
 * be declared first. Both halves live here now, next to the catalog schema that
 * refuses a catalog whose templates could ever match the same request — so a
 * match is unique by construction, not by ordering.
 */

/** The part of a catalog tool this module needs. */
export interface CatalogInvocationTemplate {
  readonly method: string;
  readonly path: string;
}

interface InvocationCarrier {
  readonly name: string;
  readonly invocation: CatalogInvocationTemplate;
}

const PARAMETER_SEGMENT = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** The `{name}` placeholders of a path template, in order. */
export function catalogInvocationPathParameters(path: string): string[] {
  return pathSegments(path).flatMap((segment) => {
    const parameter = PARAMETER_SEGMENT.exec(segment)?.[1];
    return parameter ? [parameter] : [];
  });
}

/**
 * Whether one concrete request could match BOTH templates.
 *
 * Same method, same number of segments, and at every position either the same
 * literal or a parameter on at least one side. `/messages/{id}` and
 * `/messages/unread` overlap (the request `/messages/unread` fits both);
 * `/messages/{id}` and `/messages/{id}/thread` do not.
 */
export function catalogInvocationsOverlap(
  left: CatalogInvocationTemplate,
  right: CatalogInvocationTemplate,
): boolean {
  if (left.method.toUpperCase() !== right.method.toUpperCase()) return false;
  const leftSegments = pathSegments(left.path);
  const rightSegments = pathSegments(right.path);
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((segment, index) => {
    const other = rightSegments[index] ?? '';
    return segment === other || PARAMETER_SEGMENT.test(segment) || PARAMETER_SEGMENT.test(other);
  });
}

/**
 * Whether two templates name the same ADDRESS: same method, and at every
 * position the same literal or a parameter on both sides — parameter names do
 * not matter (`/messages/{id}` and `/messages/{emailId}` are one address;
 * `/messages/{id}` and `/messages/bundled` are not, though they overlap).
 * Used to say which documented REST operation shares its address with a tool.
 */
export function catalogInvocationTemplatesEquivalent(
  left: CatalogInvocationTemplate,
  right: CatalogInvocationTemplate,
): boolean {
  if (left.method.toUpperCase() !== right.method.toUpperCase()) return false;
  const leftSegments = pathSegments(left.path);
  const rightSegments = pathSegments(right.path);
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((segment, index) => {
    const other = rightSegments[index] ?? '';
    const leftIsParameter = PARAMETER_SEGMENT.test(segment);
    return leftIsParameter ? PARAMETER_SEGMENT.test(other) : segment === other;
  });
}

/** Every pair of tools whose invocations overlap — empty for a valid catalog. */
export function findOverlappingCatalogInvocations<T extends InvocationCarrier>(
  tools: readonly T[],
): Array<readonly [T, T]> {
  const overlaps: Array<readonly [T, T]> = [];
  for (let left = 0; left < tools.length; left += 1) {
    for (let right = left + 1; right < tools.length; right += 1) {
      const a = tools[left];
      const b = tools[right];
      if (a && b && catalogInvocationsOverlap(a.invocation, b.invocation)) overlaps.push([a, b]);
    }
  }
  return overlaps;
}

export interface CatalogInvocationMatch<T> {
  readonly tool: T;
  /** Decoded path parameters, keyed by their template names. */
  readonly params: Record<string, string>;
}

function matchTemplate(
  template: CatalogInvocationTemplate,
  method: string,
  requestSegments: readonly string[],
): Record<string, string> | null {
  if (template.method.toUpperCase() !== method.toUpperCase()) return null;
  const templateSegments = pathSegments(template.path);
  if (templateSegments.length !== requestSegments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, templateSegment] of templateSegments.entries()) {
    const requestSegment = requestSegments[index];
    if (!requestSegment) return null;
    const parameter = PARAMETER_SEGMENT.exec(templateSegment)?.[1];
    if (!parameter) {
      if (templateSegment !== requestSegment) return null;
      continue;
    }
    try {
      params[parameter] = decodeURIComponent(requestSegment);
    } catch {
      return null;
    }
  }
  return params;
}

/**
 * The ONE tool whose invocation matches `method` + `path` (the full app-local
 * path, e.g. `/email/messages/abc`), or null.
 *
 * Every tool is tried, not the first hit, so the answer cannot depend on the
 * order the catalog lists its tools in. A second hit means the catalog should
 * never have validated — `appCapabilityCatalogSchema` refuses overlapping
 * templates — so it throws rather than guessing which tool the ticket meant.
 */
export function matchCatalogInvocation<T extends InvocationCarrier>(
  tools: readonly T[],
  method: string,
  path: string,
): CatalogInvocationMatch<T> | null {
  const requestSegments = pathSegments(path);
  const matches: Array<CatalogInvocationMatch<T>> = [];
  for (const tool of tools) {
    const params = matchTemplate(tool.invocation, method, requestSegments);
    if (params) matches.push({ tool, params });
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous catalog invocation ${method} ${path}: ${matches.map(({ tool }) => tool.name).join(', ')}`,
    );
  }
  return matches[0] ?? null;
}

export interface ResolvedCatalogInvocation {
  readonly method: string;
  readonly url: URL;
  /** JSON body for non-GET invocations; GET arguments travel in the query. */
  readonly body?: Record<string, unknown>;
}

/**
 * Build the HTTP request for a tool call from the model's arguments.
 *
 * Path parameters are substituted (and removed from the remaining arguments);
 * GET sends the rest as query parameters, everything else as a JSON body. A GET
 * argument that is not a scalar is refused instead of being stringified into
 * `[object Object]` — the catalog schema only lets GET tools declare scalar
 * inputs, so reaching that branch means the arguments did not come from the
 * tool's own schema. The resolved URL must stay on `internalBaseUrl`'s origin.
 */
export function resolveCatalogInvocation(
  catalog: { readonly internalBaseUrl: string },
  tool: InvocationCarrier,
  args: Readonly<Record<string, unknown>>,
): ResolvedCatalogInvocation {
  const remaining: Record<string, unknown> = { ...args };
  const path = tool.invocation.path.replace(/\{(\w+)\}/g, (_match, parameter: string) => {
    const value = Object.prototype.hasOwnProperty.call(remaining, parameter)
      ? remaining[parameter]
      : undefined;
    delete remaining[parameter];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing required path parameter: ${parameter}`);
    }
    return encodeURIComponent(String(value));
  });
  const baseUrl = new URL(catalog.internalBaseUrl);
  const url = new URL(path, `${baseUrl.origin}/`);
  if (url.origin !== baseUrl.origin) {
    throw new Error(`Catalog invocation for ${tool.name} escapes its registered app origin`);
  }
  const method = tool.invocation.method.toUpperCase();
  if (method !== 'GET') return { method, url, body: remaining };

  for (const [key, value] of Object.entries(remaining)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`GET argument ${key} of ${tool.name} must be a string, number or boolean`);
    }
    url.searchParams.set(key, String(value));
  }
  return { method, url };
}
