import { canonicalFederationHost, readProxyDeclarations } from '@oxy.so/federation';
import { federationBridges } from '../../config/federationBridgePolicy';
import { decodeHtmlEntities, sanitizePlainText } from '../../utils/sanitize';

/** Identity decisions are made exclusively from documents fetched by Oxy. */
export interface ExternalActorProfile {
  actorUri: string;
  domain: string;
  username: string;
  transportAcct: string;
  protocol: 'activitypub' | 'atproto';
  displayName: string;
  avatarUrl?: string;
  bio: string;
  evidenceLinks: string[];
  stableId?: string;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? decodeHtmlEntities(match[1] ?? match[2]) : undefined;
}

/** Only explicit rel=me links are identity claims; arbitrary bio links are not. */
export function identityLinks(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const links: string[] = [];
  for (const match of value.matchAll(/<a\b([^>]*)>/gi)) {
    const rel = attribute(match[1], 'rel');
    const href = attribute(match[1], 'href');
    if (href && rel?.toLowerCase().split(/\s+/).includes('me')) links.push(href);
  }
  return links;
}

/** Qualify only standalone mentions, preserving email addresses and URL paths. */
export function normalizeExternalBio(bio: string, domain: string, transportDomain: string): string {
  return bio.replace(/(^|[\s([{>.,!?;:])@([a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)(?:@([a-z0-9.-]+\.[a-z]{2,}))?/gi,
    (whole, prefix: string, handle: string, host: string | undefined) => {
      if (host && canonicalFederationHost(host) !== canonicalFederationHost(transportDomain)) return whole;
      return `${prefix}@${handle}@${domain}`;
    });
}

/**
 * Reviewed bridge assertions are per actor. A host entry alone never permits
 * substituting its preferredUsername for an upstream identity.
 */
export function deriveExternalActorProfile(actor: Record<string, unknown>, actorUri: string, _transportAcct?: string): ExternalActorProfile | null {
  if (actor.id !== actorUri || typeof actor.preferredUsername !== 'string') return null;
  const actorUrl = new URL(actorUri);
  if (actorUrl.protocol !== 'https:' || actorUrl.username || actorUrl.password) return null;
  const host = canonicalFederationHost(actorUrl.hostname);
  const local = actor.preferredUsername.trim().toLowerCase();
  if (!local || /[\s@/#?]/.test(local)) return null;
  // Transport hints are routing hints, never identity assertions. Even a hint
  // on the correct host cannot rename Bob's actor to Alice.
  const transport = `${local}@${host}`;
  const fields = Array.isArray(actor.attachment) ? actor.attachment.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];
  const links = fields.flatMap((field) => identityLinks(field.value));
  const aliases = Array.isArray(actor.alsoKnownAs) ? actor.alsoKnownAs.filter((value): value is string => typeof value === 'string') : [];
  const bio = sanitizePlainText(typeof actor.summary === 'string' ? actor.summary.replace(/<br\s*\/?\s*>|<\/p>/gi, '\n') : '');
  let domain = host === 'threads.com' ? 'threads.net' : host;
  let username = `${local}@${domain}`;
  let normalizedBio = bio;
  let stableId: string | undefined;
  if (['threads.net', 'threads.com'].includes(host) && /^\/ap\/users\/[0-9]+\/?$/.test(actorUrl.pathname)) {
    stableId = actorUri;
  }
  const candidate = {
    host, acct: transport, preferredUsername: actor.preferredUsername, actorUri,
    actorType: typeof actor.type === 'string' ? actor.type : '', alsoKnownAs: aliases,
    fields: fields.filter(field => typeof field.name === 'string' && typeof field.value === 'string')
      .map(field => ({ name: field.name as string, value: field.value as string })),
    proxyOf: readProxyDeclarations(actor.proxyOf), bio,
  };
  const derived = federationBridges.deriveNetworkIdentity(candidate);
  if (derived) {
    domain = derived.instanceDomain;
    username = derived.federatedUsername;
    normalizedBio = derived.bio;
    if (host === 'bsky.brid.gy') {
      const dids = aliases.filter(value => /^did:(plc|web):[^\s]+$/.test(value));
      if (new Set(dids).size === 1) stableId = dids[0];
    }
  }
  // Cross-network equivalence consumes explicit source claims only. A trusted
  // Instagram bridge may reproduce the author's links; its Official assertion
  // names Instagram itself and cannot alone establish an Instagram/Threads pair.
  const icon = actor.icon && typeof actor.icon === 'object' ? actor.icon as Record<string, unknown> : undefined;
  return {
    actorUri, domain, username, transportAcct: transport, protocol: 'activitypub',
    displayName: typeof actor.name === 'string' ? decodeHtmlEntities(actor.name) : local,
    avatarUrl: typeof icon?.url === 'string' ? icon.url : undefined,
    bio: normalizeExternalBio(normalizedBio, domain, host),
    evidenceLinks: [...new Set([...links, ...aliases.filter((value) => value.startsWith('https://'))])],
    stableId,
  };
}
