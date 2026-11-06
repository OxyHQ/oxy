import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import {
  ClarityError,
  resolveFaviconUrl,
  type ClarityClient,
  type Document,
  type ResolveResult,
} from '@clarity.surf/sdk';
import { clarityForOxyService } from '@clarity.surf/sdk/server';

import { BadRequestError, ServiceUnavailableError } from '../utils/error';

/**
 * Oxy's link to Clarity. A profile link is a Clarity document: Clarity holds the
 * URL, its title, description, image and favicon, and Oxy keeps only the
 * document id, the owner's own title and the link's position. No URL is stored
 * here, so reads go through Clarity every time (with a short-lived cache).
 *
 * The call is made as Oxy's own workload (the same transport the Inbox and
 * Peable clients use), so Clarity authorises it as a first-party caller.
 */

/** Most URLs one `indexing.resolve` call takes; Clarity's limit. */
const RESOLVE_BATCH = 25;
/** How long a read of a document is reused before Clarity is asked again. */
const DOCUMENT_TTL_MS = 10 * 60 * 1000;
const DOCUMENT_CACHE_MAX = 5000;

export interface ClarityLinkDocument {
  id: string;
  canonicalUrl: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  faviconUrl: string | null;
}

/** A URL Clarity has not finished fetching yet; retry later. */
export interface ClarityLinkPending {
  url: string;
  status: 'queued' | 'throttled' | 'unavailable';
}

/** Clarity could not be reached or answered with an error. Answered as a 503: retry later. */
export class ClarityLinkUnavailableError extends ServiceUnavailableError {
  constructor(message = 'Clarity is temporarily unavailable') {
    super(message);
    this.name = 'ClarityLinkUnavailableError';
  }
}

let client: ClarityClient | undefined;

/** Clarity's client over Oxy's workload identity, created once per process. */
function clarity(): ClarityClient {
  client ??= clarityForOxyService(
    new OxyServer({
      baseURL: (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, ''),
      workloadCredentials: createAwsWorkloadCredentialProvider(),
    }),
  );
  return client;
}

function toLinkDocument(document: Document): ClarityLinkDocument {
  return {
    id: document.id,
    canonicalUrl: document.canonicalUrl,
    title: document.title,
    description: document.description,
    imageUrl: document.imageUrl,
    faviconUrl: document.faviconUrl ?? resolveFaviconUrl(document.canonicalUrl) ?? null,
  };
}

/**
 * Asks Clarity for each URL's document, waiting up to `waitMs` for a crawl that
 * is already running. Returns the document for every URL Clarity has fetched,
 * and the URLs it has not (still queued, throttled or refused).
 */
export async function resolveLinkDocuments(
  urls: readonly string[],
  waitMs: number,
): Promise<{ documents: Map<string, ClarityLinkDocument>; pending: ClarityLinkPending[] }> {
  const documents = new Map<string, ClarityLinkDocument>();
  const pending: ClarityLinkPending[] = [];
  for (let start = 0; start < urls.length; start += RESOLVE_BATCH) {
    const batch = urls.slice(start, start + RESOLVE_BATCH);
    let results: ResolveResult[];
    try {
      ({ data: results } = await clarity().indexing.resolve({ urls: [...batch], waitMs }));
    } catch (error) {
      if (error instanceof ClarityError && error.status < 500) {
        // A client-side refusal (a URL Clarity will never index) is not an outage.
        for (const url of batch) pending.push({ url, status: 'unavailable' });
        continue;
      }
      throw new ClarityLinkUnavailableError();
    }
    for (const result of results) {
      if (result.document) {
        const document = toLinkDocument(result.document);
        remember(document);
        documents.set(result.url, document);
      } else {
        const status =
          result.status === 'queued' || result.status === 'throttled'
            ? result.status
            : 'unavailable';
        pending.push({ url: result.url, status });
      }
    }
  }
  return { documents, pending };
}

interface CachedDocument {
  document: ClarityLinkDocument | null;
  expiresAt: number;
}
const documentCache = new Map<string, CachedDocument>();

function remember(document: ClarityLinkDocument): void {
  if (documentCache.size >= DOCUMENT_CACHE_MAX) {
    const oldest = documentCache.keys().next().value;
    if (oldest !== undefined) documentCache.delete(oldest);
  }
  documentCache.set(document.id, { document, expiresAt: Date.now() + DOCUMENT_TTL_MS });
}

/**
 * The documents for these ids. An id Clarity no longer has comes back `null`:
 * the link is gone upstream, not a transient failure.
 */
export async function readLinkDocuments(
  ids: readonly string[],
): Promise<Map<string, ClarityLinkDocument | null>> {
  const out = new Map<string, ClarityLinkDocument | null>();
  const misses: string[] = [];
  const now = Date.now();
  for (const id of new Set(ids)) {
    const cached = documentCache.get(id);
    if (cached && cached.expiresAt > now) out.set(id, cached.document);
    else misses.push(id);
  }
  await Promise.all(
    misses.map(async (id) => {
      try {
        const document = toLinkDocument(await clarity().documents.get(id));
        remember(document);
        out.set(id, document);
      } catch (error) {
        if (error instanceof ClarityError && error.status === 404) {
          out.set(id, null);
          return;
        }
        throw new ClarityLinkUnavailableError();
      }
    }),
  );
  return out;
}

/** Rejects a link whose URL is not an absolute public http(s) address. */
export function assertLinkUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError('A profile link must be an absolute URL', { field: 'linksMetadata' });
  }
  if (parsed.protocol !== 'https:') {
    throw new BadRequestError('A profile link must use https://', { field: 'linksMetadata' });
  }
}
