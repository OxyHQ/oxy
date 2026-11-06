import type { AccountKind, Pronouns } from '@oxy.so/contracts';
import {
  type ActorKindSignals,
  accountKindForActor,
  apImageUrl,
  apIriList,
  apList,
  canonicalFederationHost,
  readProxyDeclarations,
} from '@oxy.so/federation';
import { federationBridges } from '../../config/federationBridgePolicy';
import { decodeHtmlEntities, sanitizePlainText } from '../../utils/sanitize';

/** A link the source profile names: the title its author gave it and its address. */
export interface ExternalActorLink {
  title: string;
  url: string;
}

/** Most links a source profile contributes; the owner's own limit applies to the account. */
export const EXTERNAL_PROFILE_LINKS_MAX = 10;

/** Identity decisions are made exclusively from documents fetched by Oxy. */
export interface ExternalActorProfile {
  actorUri: string;
  domain: string;
  username: string;
  transportAcct: string;
  protocol: 'activitypub' | 'atproto' | 'instagram-graph';
  displayName: string;
  /**
   * The actor-document fields that decide the account kind (`type`,
   * `postingRestrictedToMods`), read through {@link externalProfileKind}.
   * Absent for sources with no such notion (atproto profiles, Instagram
   * Graph), which never change a stored kind.
   */
  actor?: ActorKindSignals;
  avatarUrl?: string;
  bio: string;
  /** The profile's links (its link fields, or Bluesky's), in the author's order. */
  links: ExternalActorLink[];
  /** The closed pronoun its "Pronouns" field names; absent when it names none. */
  pronouns?: Pronouns;
  evidenceLinks: string[];
  stableId?: string;
}

/** The spellings of a pronoun pair a source writes, mapped onto the closed list. */
const PRONOUN_SPELLINGS = new Map<string, Pronouns>([
  ['he/him', 'he_him'],
  ['she/her', 'she_her'],
  ['they/them', 'they_them'],
  ['he/they', 'he_they'],
  ['she/they', 'she_they'],
  ['it/its', 'it_its'],
]);

/**
 * The closed pronoun a profile's "Pronouns" field declares. A field whose value
 * is not one of the listed pairs declares `unspecified`: free text is never
 * stored. `undefined` when the profile has no such field.
 */
export function pronounsFromFields(
  fields: readonly Record<string, unknown>[],
): Pronouns | undefined {
  for (const field of fields) {
    if (typeof field.name !== 'string' || typeof field.value !== 'string') continue;
    const name = decodeHtmlEntities(field.name)
      .replace(/[\s:]+$/, '')
      .trim()
      .toLowerCase();
    if (name !== 'pronouns' && name !== 'pronoun') continue;
    const value = decodeHtmlEntities(field.value.replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, '')
      .toLowerCase();
    return PRONOUN_SPELLINGS.get(value) ?? 'unspecified';
  }
  return undefined;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? decodeHtmlEntities(match[1] ?? match[2]) : undefined;
}

/**
 * The link a profile field names: its value as a URL, or the first `https` href
 * of the anchor it is written as. The title is the field's own name.
 */
export function fieldLink(field: Record<string, unknown>): ExternalActorLink | null {
  if (typeof field.name !== 'string' || typeof field.value !== 'string') return null;
  const title = decodeHtmlEntities(field.name).replace(/\s+/g, ' ').trim();
  const candidates = [
    field.value.trim(),
    ...[...field.value.matchAll(/<a\b[^>]*>/gi)].map((match) => attribute(match[0], 'href') ?? ''),
  ];
  for (const candidate of candidates) {
    const url = httpsUrl(candidate);
    if (url) return { title: title || new URL(url).hostname, url };
  }
  return null;
}

/** The `https` address a string is, normalised; `null` for anything else. */
export function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
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
  return bio.replace(
    /(^|[\s([{>.,!?;:])@([a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)(?:@([a-z0-9.-]+\.[a-z]{2,}))?/gi,
    (whole, prefix: string, handle: string, host: string | undefined) => {
      if (host && canonicalFederationHost(host) !== canonicalFederationHost(transportDomain))
        return whole;
      return `${prefix}@${handle}@${domain}`;
    },
  );
}

/**
 * Reviewed bridge assertions are per actor. A host entry alone never permits
 * substituting its preferredUsername for an upstream identity.
 */
export function deriveExternalActorProfile(
  actor: Record<string, unknown>,
  actorUri: string,
  _transportAcct?: string,
): ExternalActorProfile | null {
  if (actor.id !== actorUri || typeof actor.preferredUsername !== 'string') return null;
  const actorUrl = new URL(actorUri);
  if (actorUrl.protocol !== 'https:' || actorUrl.username || actorUrl.password) return null;
  const host = canonicalFederationHost(actorUrl.hostname);
  const local = actor.preferredUsername.trim().toLowerCase();
  if (!local || /[\s@/#?]/.test(local)) return null;
  // Transport hints are routing hints, never identity assertions. Even a hint
  // on the correct host cannot rename Bob's actor to Alice.
  const transport = `${local}@${host}`;
  // One profile field or alias is sent as the value itself (JSON-LD compaction),
  // a list as a list; both are the actor's statement.
  const fields = apList(actor.attachment).filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && !Array.isArray(entry),
  );
  const links = fields.flatMap((field) => identityLinks(field.value));
  const profileLinks = uniqueLinks(
    fields.flatMap((field) => {
      const link = fieldLink(field);
      return link ? [link] : [];
    }),
  );
  const aliases = apIriList(actor.alsoKnownAs);
  const bio = sanitizePlainText(
    typeof actor.summary === 'string' ? actor.summary.replace(/<br\s*\/?\s*>|<\/p>/gi, '\n') : '',
  );
  let domain = host === 'threads.com' ? 'threads.net' : host;
  let username = `${local}@${domain}`;
  let normalizedBio = bio;
  let stableId: string | undefined;
  // Native WebFinger can name a handle-shaped AP URI (for example mosseri).
  // The whole actor URI is the source ID; its path is never a username proof.
  // Meta equivalence still requires exact WebFinger/actor and first-party bindings.
  if (
    ['threads.net', 'threads.com'].includes(host) &&
    !actorUrl.search &&
    !actorUrl.hash &&
    !actorUrl.port &&
    /^\/ap\/users\/(?:[0-9]+|[a-zA-Z0-9_][a-zA-Z0-9._]{0,63})\/?$/.test(actorUrl.pathname)
  ) {
    stableId = actorUri;
  }
  const candidate = {
    host,
    acct: transport,
    preferredUsername: actor.preferredUsername,
    actorUri,
    actorType: typeof actor.type === 'string' ? actor.type : '',
    alsoKnownAs: aliases,
    fields: fields
      .filter((field) => typeof field.name === 'string' && typeof field.value === 'string')
      .map((field) => ({ name: field.name as string, value: field.value as string })),
    proxyOf: readProxyDeclarations(actor.proxyOf),
    bio,
  };
  let derived = federationBridges.deriveNetworkIdentity(candidate);
  // Bridgy Fed omits the `Web site` field for some accounts but still publishes
  // the same bsky.app profile as its `url` (behind its /r/ redirector). That
  // URL is the bridge's own per-actor assertion, like the field; it counts only
  // when it names the actor's preferredUsername, and the DID rule still applies.
  if (!derived && host === 'bsky.brid.gy' && typeof actor.url === 'string') {
    const handle =
      /^https:\/\/bsky\.brid\.gy\/r\/https:\/\/bsky\.app\/profile\/([a-z0-9.-]+)$/i.exec(
        actor.url,
      )?.[1];
    if (handle && handle.toLowerCase() === String(actor.preferredUsername).toLowerCase()) {
      const link = `<a href="https://bsky.app/profile/${handle}" rel="me">https://bsky.app/profile/${handle}</a>`;
      derived = federationBridges.deriveNetworkIdentity({
        ...candidate,
        fields: [...candidate.fields, { name: 'Web site', value: link }],
      });
    }
  }
  if (derived) {
    domain = derived.instanceDomain;
    username = derived.federatedUsername;
    normalizedBio = derived.bio;
    if (host === 'bsky.brid.gy') {
      const dids = aliases.filter((value) => /^did:(plc|web):[^\s]+$/.test(value));
      if (new Set(dids).size === 1) stableId = dids[0];
    }
  }
  // Cross-network equivalence consumes explicit source claims only. A trusted
  // Instagram bridge may reproduce the author's links; its Official assertion
  // names Instagram itself and cannot alone establish an Instagram/Threads pair.
  return {
    actorUri,
    domain,
    username,
    transportAcct: transport,
    protocol: 'activitypub',
    displayName: typeof actor.name === 'string' ? decodeHtmlEntities(actor.name) : local,
    actor: { type: actor.type, postingRestrictedToMods: actor.postingRestrictedToMods },
    // A URL string, an Image (url string, Link or list) or a list of Images.
    avatarUrl: apImageUrl(actor.icon),
    bio: normalizeExternalBio(normalizedBio, domain, host),
    links: profileLinks,
    pronouns: pronounsFromFields(fields),
    evidenceLinks: [
      ...new Set([...links, ...aliases.filter((value) => value.startsWith('https://'))]),
    ],
    stableId,
  };
}

/** Keeps the first of each address, up to the limit. */
export function uniqueLinks(links: readonly ExternalActorLink[]): ExternalActorLink[] {
  const seen = new Set<string>();
  const out: ExternalActorLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
    if (out.length === EXTERNAL_PROFILE_LINKS_MAX) break;
  }
  return out;
}

/**
 * The account kind a source profile declares, read from the one actor-type
 * table (`accountKindForActor` in `@oxy.so/federation`), or `undefined` for a
 * source that declares none.
 */
export function externalProfileKind(
  profile: Pick<ExternalActorProfile, 'actor'>,
): AccountKind | undefined {
  return profile.actor ? accountKindForActor(profile.actor) : undefined;
}
