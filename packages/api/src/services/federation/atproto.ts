/**
 * Bluesky (atproto) sources: a DID's profile through the public AppView, and a
 * handle's DID. Bluesky speaks no WebFinger, so these replace discovery for it.
 */

import {
  atprotoIdentityHandle,
  blueskyUsernameFromHandle,
  BSKY_NETWORK_DOMAIN,
} from '@oxy.so/federation';
import { safeFetch } from '@oxy.so/core/server';
import { sanitizePlainText } from '../../utils/sanitize';
import type { SourceObservation } from './externalIdentity';
import { httpsUrl, uniqueLinks, type ExternalActorLink } from './externalIdentityPolicy';
import { ATPROTO_DID_RE } from './handles';
import { readFederationJson, safeFederationFetch } from './transport';

/**
 * One `app.bsky.actor.getProfile` read of a DID: the identity profile Oxy
 * derives from it, and the profile view itself (counts, banner, creation date
 * and labels, which Oxy does not keep and returns to the resolve caller).
 */
export async function fetchAtprotoSource(did: string): Promise<SourceObservation | null> {
  if (!ATPROTO_DID_RE.test(did)) return null;
  const response = await safeFetch(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    {
      headers: { Accept: 'application/json' },
      headersTimeoutMs: 10_000,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status < 200 || response.status >= 300) {
    response.response.destroy();
    return null;
  }
  const profile = await readFederationJson<Record<string, unknown>>(response.response);
  if (
    profile?.did !== did ||
    typeof profile.handle !== 'string' ||
    !/^[a-z0-9.-]+$/i.test(profile.handle)
  )
    return null;
  // An unverified handle is Bluesky's shared `handle.invalid`: name it by its DID.
  const handle = atprotoIdentityHandle(profile.handle, did).toLowerCase();
  return {
    profile: {
      actorUri: did,
      protocol: 'atproto',
      domain: BSKY_NETWORK_DOMAIN,
      username: `${blueskyUsernameFromHandle(handle)}@${BSKY_NETWORK_DOMAIN}`,
      transportAcct: handle,
      stableId: did,
      evidenceLinks: [],
      links: atprotoLinks(profile.links),
      displayName: typeof profile.displayName === 'string' ? profile.displayName : handle,
      bio: sanitizePlainText(typeof profile.description === 'string' ? profile.description : ''),
      avatarUrl: typeof profile.avatar === 'string' ? profile.avatar : undefined,
    },
    document: profile,
  };
}

/**
 * The links a Bluesky profile names (`profileViewDetailed.links`), as the profile
 * shows them: https only, the author's title, the author's order.
 */
function atprotoLinks(value: unknown): ExternalActorLink[] {
  if (!Array.isArray(value)) return [];
  const links: ExternalActorLink[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { url, title } = entry as { url?: unknown; title?: unknown };
    if (typeof url !== 'string') continue;
    const href = httpsUrl(url);
    if (!href) continue;
    const label = typeof title === 'string' ? sanitizePlainText(title).trim() : '';
    links.push({ title: label || new URL(href).hostname, url: href });
  }
  return uniqueLinks(links);
}

/** The DID a Bluesky handle names, or null when the AppView cannot resolve it. */
export async function resolveAtprotoHandle(handle: string): Promise<string | null> {
  const response = await safeFederationFetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response) return null;
  if (response.status < 200 || response.status >= 300) {
    response.response.destroy();
    return null;
  }
  const body = await readFederationJson<Record<string, unknown>>(response.response);
  return typeof body?.did === 'string' && ATPROTO_DID_RE.test(body.did) ? body.did : null;
}
