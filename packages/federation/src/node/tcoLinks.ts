/**
 * Expanding X's `t.co` link wrapper back into the link the author posted.
 *
 * X rewrites EVERY link in a post or bio into `https://t.co/<id>`, and a bridge
 * that mirrors an X account (bird.makeup, mastox) republishes that text as it
 * is: the actor `summary` and the Note `content` carry only the wrapper. The
 * author never wrote `t.co`; it is X's click tracker standing in for their link,
 * and an X API client never shows it because it reads the expansion beside it.
 * The bridges drop that expansion, so the only place left to recover it is the
 * wrapper's own redirect.
 *
 * Only `t.co` is unwrapped, and only ONE hop. A `bit.ly` the author chose is
 * their link and stays; so does wherever their link redirects next. What is
 * replaced is exactly X's wrapper, by exactly the URL it names.
 *
 * The transport is injected — the same SSRF-safe, IP-pinned single-hop fetch
 * {@link createSignedFetch} takes — so each backend keeps its own network
 * contract. A link that does not resolve (timeout, 404, a malformed or
 * self-referencing `Location`) is left as `t.co`: still a working link, never a
 * broken one.
 */

import type { SingleHopFetch } from './signedFetch';

/**
 * A `t.co` link in plain text. X ids are alphanumeric; the lookahead stops a
 * longer token (`t.co/abc/def`, `t.co/abcé`) from being half-replaced.
 */
const TCO_LINK = /\bhttps?:\/\/t\.co\/([A-Za-z0-9]+)(?![\w/])/gi;
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** A link that has not answered by then is kept as `t.co`. */
const TCO_TIMEOUT_MS = 5_000;
/** Bounds the requests one text can cost; the rest keep their wrapper. */
const MAX_LINKS_PER_TEXT = 10;

/**
 * A store of resolved wrappers, keyed by the `t.co` id. A wrapper never changes
 * what it points to, so an entry never goes stale. Failures are not cached.
 */
export interface TcoLinkCache {
  get(id: string): Promise<string | null | undefined>;
  set(id: string, target: string): Promise<void>;
}

/** Adapters a {@link TcoLinkExpander} is built from. */
export interface CreateTcoLinkExpanderConfig {
  /** SSRF-safe single-hop transport (does NOT follow redirects). */
  fetchSingleHop: SingleHopFetch;
  /** User-Agent presented to t.co. A browser UA gets an HTML page instead of the 301. */
  userAgent: string;
  cache?: TcoLinkCache;
}

/** Replace every `t.co` link in `text` with the URL it redirects to. */
export type TcoLinkExpander = (text: string) => Promise<string>;

/** The `t.co` ids in `text`, in order of first appearance. */
function findTcoLinkIds(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(TCO_LINK), (match) => match[1]))];
}

/** The redirect target, if it is an http(s) URL that is not another `t.co` wrapper. */
function readTarget(response: Response, from: string): string | null {
  if (!REDIRECT_STATUS_CODES.has(response.status)) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (target.hostname.toLowerCase() === 't.co') return null;
  return target.href;
}

export function createTcoLinkExpander(config: CreateTcoLinkExpanderConfig): TcoLinkExpander {
  const { cache } = config;

  async function resolve(id: string): Promise<string | null> {
    const cached = await cache?.get(id).catch(() => null);
    if (cached) return cached;
    const from = `https://t.co/${id}`;
    let target: string | null;
    try {
      const response = await config.fetchSingleHop(from, {
        headers: { Accept: '*/*', 'User-Agent': config.userAgent },
        signal: AbortSignal.timeout(TCO_TIMEOUT_MS),
        headersTimeoutMs: TCO_TIMEOUT_MS,
      });
      target = readTarget(response, from);
      await response.body?.cancel().catch(() => undefined);
    } catch {
      return null;
    }
    if (target) await cache?.set(id, target).catch(() => undefined);
    return target;
  }

  return async function expandTcoLinks(text: string): Promise<string> {
    const ids = findTcoLinkIds(text).slice(0, MAX_LINKS_PER_TEXT);
    if (ids.length === 0) return text;
    const targets = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        const target = await resolve(id);
        if (target) targets.set(id, target);
      }),
    );
    if (targets.size === 0) return text;
    return text.replace(TCO_LINK, (whole, id: string) => targets.get(id) ?? whole);
  };
}
