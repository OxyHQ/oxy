/**
 * Outbound federation transport: the SSRF-safe fetch every federation request
 * goes through, the signed ActivityPub GET built on the shared
 * `@oxy.so/federation/node` engine, the bounded JSON readers, and the `t.co`
 * expander for bridged X bios.
 */

import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import {
  createSignedFetcher,
  createTcoLinkExpander,
  readBoundedResponseJson,
  type SignedFetchLogger,
  type SignedFetchResult,
  type SingleHopFetch,
} from '@oxy.so/federation/node';
import {
  readResponseJson,
  safeFetch,
  SsrfRejection,
  type SafeFetchResult,
} from '@oxy.so/core/server';
import { logger } from '../../utils/logger';
import { composeInstanceKeyId, getInstanceKeyPair, signWithKeyId } from './actorKeys';
import { AP_DOMAIN } from './ownDomain';
import { safeActorSelector } from './resolutionFailure';

export const AP_ACCEPT_TYPES = [
  'application/activity+json',
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
];

export const USER_AGENT = 'OxyHQ/1.0 (ActivityPub)';

/** Time-to-first-byte deadline for federation control-plane fetches (webfinger/actor). */
export const FEDERATION_FETCH_TIMEOUT_MS = 10_000;
/**
 * Whole-body deadline once a JSON document's headers are in. It equals the
 * fetch's deadline, which the fetch's `AbortSignal` already holds from the
 * request's start: a JSON document is at most 2 MiB (≥ 200 KiB/s), and the
 * actor documents peers serve are KBs.
 */
const FEDERATION_JSON_BODY_TIMEOUT_MS = 10_000;
/**
 * Hard cap on a federation JSON document (WebFinger JRD / ActivityPub actor).
 * Generous for legitimate actor objects, but bounds a hostile peer streaming an
 * unbounded body to exhaust memory.
 */
const FEDERATION_MAX_JSON_BYTES = 2 * 1024 * 1024;

/**
 * SSRF-safe federation fetch. All outbound federation traffic is funnelled here
 * so it inherits {@link safeFetch}'s DNS-pinned, redirect-revalidating,
 * private/metadata-IP denylisting protection (closing the DNS-rebind TOCTOU).
 * Restricted to https only — federation never legitimately targets http.
 *
 * Returns the validated, non-redirect {@link SafeFetchResult}, or `null` when the
 * URL is not https, is rejected by the SSRF guard, or the request fails. The
 * caller OWNS the returned `response` stream — read it with
 * {@link readFederationJson} or `readResponseBody`, which cap its bytes and
 * time.
 */
export async function safeFederationFetch(
  rawUrl: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<SafeFetchResult | null> {
  let protocol: string;
  try {
    protocol = new URL(rawUrl).protocol;
  } catch {
    logger.warn('Federation URL rejected', { reason: 'malformed' });
    return null;
  }
  if (protocol !== 'https:') {
    logger.warn('Federation URL rejected', { reason: 'non_https' });
    return null;
  }

  try {
    return await safeFetch(rawUrl, {
      method: 'GET',
      headers: options.headers,
      headersTimeoutMs: options.timeoutMs ?? FEDERATION_FETCH_TIMEOUT_MS,
      signal: AbortSignal.timeout(options.timeoutMs ?? FEDERATION_FETCH_TIMEOUT_MS),
      maxRedirects: options.maxRedirects,
    });
  } catch (err) {
    if (err instanceof SsrfRejection) {
      logger.warn('Federation URL rejected', {
        reason: 'ssrf_rejected',
        actorUri: safeActorSelector(rawUrl),
      });
      return null;
    }
    logger.warn('Federation fetch failed', {
      reason: 'transport_unavailable',
      actorUri: safeActorSelector(rawUrl),
    });
    return null;
  }
}

/**
 * A bridged X account's bio carries X's `t.co` wrapper for every link; this
 * puts back the link the author posted. One SSRF-safe hop, never followed on.
 */
export const expandTcoLinks = createTcoLinkExpander({
  userAgent: USER_AGENT,
  fetchSingleHop: async (url, init) => {
    const res = await safeFetch(url, {
      headers: init.headers,
      signal: init.signal,
      headersTimeoutMs: init.headersTimeoutMs,
      redirect: 'manual',
    });
    res.response.destroy();
    const { location } = res.headers;
    return new Response(null, {
      status: res.status,
      headers: typeof location === 'string' ? { location } : {},
    });
  },
});

/**
 * A federation JSON document (WebFinger JRD, actor, profile), or `null` when it
 * is over {@link FEDERATION_MAX_JSON_BYTES}, not JSON, or not complete within
 * {@link FEDERATION_JSON_BODY_TIMEOUT_MS}.
 */
export async function readFederationJson<T>(response: IncomingMessage): Promise<T | null> {
  const result = await readResponseJson<T>(response, {
    maxBytes: FEDERATION_MAX_JSON_BYTES,
    timeoutMs: FEDERATION_JSON_BODY_TIMEOUT_MS,
  });
  return result.kind === 'ok' ? result.value : null;
}

/**
 * The keyId of Oxy's own instance actor (`https://<AP_DOMAIN>/ap/users/instance`),
 * minting its key pair if this database has none yet — the actor route mints it
 * the same way on first read. Used by `POST /federation/instance-fetch/sign`,
 * which then signs through `signWithKeyId`, so the private key stays in
 * `actorKeys`.
 */
export async function ensureInstanceKeyId(): Promise<string> {
  return (await getInstanceKeyPair(AP_DOMAIN)).keyId;
}

/** Thrown by the single-hop transport when {@link safeFederationFetch} refused or failed the request. */
class FederationTransportUnavailable extends Error {
  constructor() {
    super('Federation transport unavailable');
    this.name = 'FederationTransportUnavailable';
  }
}

/** Statuses whose WHATWG `Response` must have a null body; a 3xx body is never read either. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * The single-hop transport the shared signed fetch runs over: one request
 * through {@link safeFederationFetch} (https-only, SSRF guard, DNS pinning and
 * its logs), never following a redirect, answered as a WHATWG `Response` whose
 * body streams the socket.
 */
const fetchFederationSingleHop: SingleHopFetch = async (url, init) => {
  const result = await safeFederationFetch(url, {
    headers: init.headers,
    timeoutMs: init.headersTimeoutMs ?? FEDERATION_FETCH_TIMEOUT_MS,
    maxRedirects: 0,
  });
  if (!result) throw new FederationTransportUnavailable();
  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }
  const nullBody =
    (result.status >= 300 && result.status < 400) || NULL_BODY_STATUSES.has(result.status);
  if (nullBody) result.response.destroy();
  return new Response(
    nullBody ? null : (Readable.toWeb(result.response) as ReadableStream<Uint8Array>),
    { status: result.status, headers },
  );
};

/** Oxy's own log lines for a signed fetch, naming the URL only through {@link safeActorSelector}. */
const signedFetchLogger: SignedFetchLogger = {
  info: (_message, detail) =>
    detail &&
    logger.info(
      `[Federation] signedFetch got ${detail.status} for ${safeActorSelector(detail.url) ?? '[invalid selector]'}, retrying unsigned`,
    ),
  warn: (_message, detail) =>
    detail &&
    logger.warn(
      `[Federation] signedFetch got ${detail.status} for ${safeActorSelector(detail.url) ?? '[invalid selector]'} — remote rejected our HTTP signature`,
    ),
};

/** Signs as the instance actor; `signWithKeyId` never mints, so a vanished key fails the request. */
async function signWithInstanceKey(keyId: string, signingString: string): Promise<string> {
  const signature = await signWithKeyId(keyId, signingString);
  if (signature === null) throw new Error('Instance signing key unavailable');
  return signature;
}

/**
 * An instance-signed ActivityPub GET over the shared `@oxy.so/federation/node`
 * engine, which re-signs every redirect hop and retries a 5xx unsigned from the
 * URL that answered.
 */
const createInstanceSignedFetcher = (getInstanceKeyId: () => Promise<string>) =>
  createSignedFetcher({
    sign: signWithInstanceKey,
    getInstanceKeyId,
    fetchSingleHop: fetchFederationSingleHop,
    userAgent: USER_AGENT,
    logger: signedFetchLogger,
  });

/** Signs with the instance key, minting its pair on first use. */
const mintingSignedFetcher = createInstanceSignedFetcher(ensureInstanceKeyId);
/**
 * Signs with the instance key only when it already exists (the caller checks
 * first) and never mints it. Still instance-signed, so a 5xx is retried
 * unsigned — which passing an explicit `init.keyId` would turn off.
 */
const readonlySignedFetcher = createInstanceSignedFetcher(async () =>
  composeInstanceKeyId(AP_DOMAIN),
);

/**
 * Fetch an ActivityPub document with HTTP Signature authentication — required by
 * servers that enforce authorized fetch (e.g. Threads). `null` when the
 * transport refused or failed a hop, as {@link safeFederationFetch} answers;
 * any HTTP status is returned. The caller owns `response.body`: read it or
 * cancel it.
 */
export async function signedFetch(
  url: string,
  accept: string,
  options: { readonlySigningKey?: boolean } = {},
): Promise<SignedFetchResult | null> {
  const fetcher = options.readonlySigningKey ? readonlySignedFetcher : mintingSignedFetcher;
  try {
    return await fetcher(url, accept);
  } catch (err) {
    if (err instanceof FederationTransportUnavailable) return null;
    // A redirect whose `Location` names no URL ends the fetch like a refused hop;
    // a malformed request URL still throws, as signing it always did.
    if (
      err instanceof TypeError &&
      (err as { code?: unknown }).code === 'ERR_INVALID_URL' &&
      URL.canParse(url)
    ) {
      return null;
    }
    throw err;
  }
}

/** Release a response body that will not be read. */
export function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/**
 * A federation JSON object from a signed fetch's `Response`, or `null` when it
 * is over {@link FEDERATION_MAX_JSON_BYTES}, not a JSON object, or not complete
 * within {@link FEDERATION_JSON_BODY_TIMEOUT_MS}.
 */
export async function readSignedFetchJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    return await readBoundedResponseJson(response, {
      maxBytes: FEDERATION_MAX_JSON_BYTES,
      timeoutMs: FEDERATION_JSON_BODY_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}
