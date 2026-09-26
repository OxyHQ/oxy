/**
 * Parser for a scanned / deep-linked "Sign in with Oxy" approval payload.
 *
 * The payload shape emitted by the API device-flow is:
 *
 *   oxycommons://approve?v=1&code=<authorizeCode>&app=<appId>&origin=<rp-origin>&nonce=<rand>&exp=<ms>
 *
 * Also accepted: the `commons://approve?...` app scheme and the
 * `https://commons.oxy.so/approve?...` universal link.
 *
 * SECURITY (anti-phishing): ONLY the `code` is extracted. The `app` / `origin`
 * / `nonce` fields carried in the payload are NEVER trusted for display — the
 * approval screen re-resolves the requesting application's identity server-side
 * via `oxyServices.auth.commons.approvalInfo(code)`. `exp` is used only as a fast
 * client-side "this link is already stale" check; the server-reported expiry is
 * authoritative.
 *
 * Pure + dependency-free so it is trivially unit-testable and runs identically
 * under Hermes and jsdom (no `URL` / `URLSearchParams` reliance).
 */

export type ParsedApprovalLink =
  | { ok: true; code: string }
  | { ok: false; reason: 'invalid' | 'expired' };

/** Schemes/hosts that introduce a Commons approval link. */
const APPROVE_MATCHERS: readonly RegExp[] = [
  /^oxycommons:\/\/approve(?:[/?#]|$)/i,
  /^commons:\/\/approve(?:[/?#]|$)/i,
  /^https:\/\/commons\.oxy\.so\/approve(?:[/?#]|$)/i,
];

/** Minimal, allocation-light query-string parser (no `URLSearchParams`). */
function parseQuery(raw: string): Map<string, string> {
  const params = new Map<string, string>();
  const qIndex = raw.indexOf('?');
  if (qIndex < 0) return params;

  let query = raw.slice(qIndex + 1);
  const hashIndex = query.indexOf('#');
  if (hashIndex >= 0) query = query.slice(0, hashIndex);

  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      params.set(
        decodeURIComponent(rawKey),
        decodeURIComponent(rawValue.replace(/\+/g, ' ')),
      );
    } catch {
      // Malformed percent-encoding — keep the raw token rather than throwing,
      // so a single bad field doesn't sink an otherwise valid `code`.
      params.set(rawKey, rawValue);
    }
  }
  return params;
}

/**
 * Parse a scanned QR string / deep-link into a usable authorize code.
 *
 * @param raw - The raw scanned string or deep-link URL.
 * @returns `{ ok: true, code }` when a usable code is present and not expired;
 *          `{ ok: false, reason }` otherwise.
 */
export function parseApprovalLink(raw: string): ParsedApprovalLink {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'invalid' };
  }

  const value = raw.trim();
  if (!APPROVE_MATCHERS.some((matcher) => matcher.test(value))) {
    return { ok: false, reason: 'invalid' };
  }

  const params = parseQuery(value);
  const code = params.get('code');
  if (!code || code.length === 0) {
    return { ok: false, reason: 'invalid' };
  }

  const exp = params.get('exp');
  if (exp) {
    const expMs = Number(exp);
    if (Number.isFinite(expMs) && expMs > 0 && expMs < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
  }

  return { ok: true, code };
}
