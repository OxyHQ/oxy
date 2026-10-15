/**
 * Whether a browser has to send a CORS preflight (`OPTIONS`) before this
 * cross-origin request goes out, per the Fetch standard's CORS-safelisted
 * methods and request headers.
 *
 * The SDK uses it for one invariant: its anonymous telemetry headers
 * (`X-Oxy-Activity-Id`, `X-Oxy-Edge-Region`) ride only on requests that are
 * preflighted anyway, so they never turn a request that would go straight out
 * into one that first waits a round trip for an `OPTIONS`. A browser caches a
 * preflight per URL, so without this every distinct anonymous read (a post's
 * replies, a profile, a public app record) paid a round trip of its own.
 *
 * Deliberately conservative: a header it does not recognise as safelisted
 * counts as needing a preflight, which only means the telemetry headers ride
 * along exactly as they always did. Value-level rules (for example `Accept`'s
 * 128-byte limit) are not modelled; a misjudgement in that direction drops two
 * advisory headers from one request and nothing else.
 */

const SAFELISTED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST']);

const SAFELISTED_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
]);

const SAFELISTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]);

export function requiresCorsPreflight(
  method: string,
  headers: Iterable<readonly [string, string]>,
): boolean {
  if (!SAFELISTED_METHODS.has(method.toUpperCase())) return true;
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!SAFELISTED_HEADERS.has(name)) return true;
    if (name === 'content-type') {
      const essence = value.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!SAFELISTED_CONTENT_TYPES.has(essence)) return true;
    }
  }
  return false;
}
