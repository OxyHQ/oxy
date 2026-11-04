/**
 * Oxy's own ActivityPub actor documents: the instance (`Application`) actor and
 * one per local user, both from the single builder.
 */

import {
  createUrlBuilders,
  INSTANCE_ACTOR_USERNAME,
  localActorTypeForAccountKind,
  normalizeAlsoKnownAs,
} from '@oxy.so/federation';
import type { ACCOUNT_KINDS } from '../../db/schema/users';
import { logger } from '../../utils/logger';
import { composeDisplayName } from '../../utils/displayName';
import { getInstanceKeyPair, getUserKeyPair } from './actorKeys';
import { getAssetService } from './avatarDownload';
import { AP_DOMAIN } from './ownDomain';

/** The `users.kind` closed value set, derived from the column itself. */
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/**
 * Inputs to {@link buildActor}. When `username` is null the actor is the
 * instance (`Application`) actor; otherwise it is a per-user (`Person`) actor.
 */
interface BuildActorOptions {
  domain: string;
  username: string | null;
  publicKeyPem: string;
  keyId: string;
  name: string;
  summary?: string;
  avatar?: string;
  /** Account graph kind → ActivityPub actor type (per-user actors only). */
  kind?: AccountKind;
  /** The account's verified aliases (per-user actors only); emitted when non-empty. */
  alsoKnownAs?: readonly string[];
}

/**
 * Single canonical builder for both the instance and per-user ActivityPub
 * actor documents. Every host-bearing field — `id`, `publicKey.id`,
 * `publicKey.owner`, `inbox`, `outbox`, `followers`, `following`, `url`, and
 * `endpoints.sharedInbox` — is derived from ONE `domain` argument so the actor
 * shape can never drift across a split set of hosts. Reducing the two actor
 * functions to this one builder is what guarantees a self-consistent actor.
 *
 * Not `@oxy.so/federation`'s `createLocalActorBuilder`: that one also emits
 * `featured` (and a Group's `moderators`) collection URLs Oxy does not serve,
 * plus `discoverable` / `manuallyApprovesFollowers`, and Oxy's documents must
 * stay byte-identical. The shared pieces are reused instead: `createUrlBuilders`,
 * `normalizeAlsoKnownAs` and `localActorTypeForAccountKind`.
 */
function buildActor(opts: BuildActorOptions): Record<string, unknown> {
  const { domain, username, publicKeyPem, keyId, name, summary, avatar, kind } = opts;
  const aliases = normalizeAlsoKnownAs(opts.alsoKnownAs);
  const base = `https://${domain}/ap`;

  // The one builder the WebFinger `self` link also uses: Mastodon compares the
  // two byte for byte before it trusts a signed fetch.
  const actorUrlFor = createUrlBuilders(domain).actor;

  if (username === null) {
    const actorUrl = actorUrlFor(INSTANCE_ACTOR_USERNAME);
    return {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      id: actorUrl,
      type: 'Application',
      preferredUsername: INSTANCE_ACTOR_USERNAME,
      name,
      summary: summary ?? '',
      url: `https://${domain}`,
      inbox: `${actorUrl}/inbox`,
      outbox: `${actorUrl}/outbox`,
      endpoints: { sharedInbox: `${base}/inbox` },
      publicKey: {
        id: keyId,
        owner: actorUrl,
        publicKeyPem,
      },
    };
  }

  const actorUrl = actorUrlFor(username);
  return {
    // The alias term is declared only when an alias is emitted, so an actor
    // without aliases keeps exactly the context it always had.
    '@context':
      aliases.length > 0
        ? [
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1',
            { alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' } },
          ]
        : ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id: actorUrl,
    type: localActorTypeForAccountKind(kind),
    preferredUsername: username,
    name,
    summary: summary ?? '',
    url: `https://${domain}/@${username}`,
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    followers: `${actorUrl}/followers`,
    following: `${actorUrl}/following`,
    endpoints: { sharedInbox: `${base}/inbox` },
    icon: avatar
      ? {
          type: 'Image',
          mediaType: 'image/png',
          url: avatar,
        }
      : undefined,
    publicKey: {
      id: keyId,
      owner: actorUrl,
      publicKeyPem,
    },
    ...(aliases.length > 0 ? { alsoKnownAs: aliases } : {}),
  };
}

/**
 * Returns the instance actor JSON-LD document for HTTP Signature key
 * verification. Self-consistent on the given `domain` (defaults to Oxy's own
 * federation domain {@link AP_DOMAIN}).
 */
export async function getInstanceActor(
  domain: string = AP_DOMAIN,
): Promise<Record<string, unknown>> {
  const keyPair = await getInstanceKeyPair(domain);
  return buildActor({
    domain,
    username: null,
    publicKeyPem: keyPair.publicKeyPem,
    keyId: keyPair.keyId,
    name: domain,
  });
}

/**
 * Resolve a local user's avatar to a publicly-fetchable absolute URL for the
 * federated actor document's `icon`.
 *
 * - Already-absolute URLs (e.g. a remote avatar mirrored verbatim) pass through.
 * - A stored Oxy file id resolves to the public CDN URL of its `thumb` variant
 *   via the asset service, so remote servers fetch from `cloud.oxy.so` — never a
 *   raw S3 URL and never the previous broken `/files/<id>/variant/thumb` scheme.
 * - Anything that cannot be resolved publicly (missing/private avatar) is
 *   omitted rather than advertising an unreachable URL.
 */
async function resolveActorAvatarUrl(avatar: unknown): Promise<string | undefined> {
  if (typeof avatar !== 'string' || avatar.length === 0) {
    return undefined;
  }
  if (avatar.startsWith('http')) {
    return avatar;
  }

  try {
    const assetService = getAssetService();
    const file = await assetService.getFile(avatar);
    if (!file) {
      return undefined;
    }
    const cdnUrl = await assetService.getPublicCdnUrl(file, 'thumb');
    return cdnUrl ?? undefined;
  } catch (error) {
    logger.warn('Failed to resolve federated actor avatar URL', {
      avatar,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The account fields an actor document is built from.
 *
 * A STRUCTURAL type rather than the whole account document: this is the entire
 * input to {@link buildActor}, so declaring it here is what lets `tsc` reject a
 * caller that hands over a row missing `kind` or `avatar` — which a
 * `Record<string, unknown>` parameter would have accepted silently.
 */
export interface ActorSourceUser {
  username?: string | null;
  name?: { first?: string | null; last?: string | null } | null;
  avatar?: string | null;
  bio?: string | null;
  description?: string | null;
  kind?: AccountKind | null;
  /** Verified aliases (`aliasesForUser`), published as the actor's `alsoKnownAs`. */
  alsoKnownAs?: readonly string[] | null;
}

/**
 * Returns a per-user actor JSON-LD document, self-consistent on `domain`
 * (defaults to Oxy's own federation domain {@link AP_DOMAIN}).
 *
 * The `name` field is the canonical composed display name (identity contract),
 * composed here via the shared {@link composeDisplayName} rules — the model
 * virtual it used to be read from does not exist on a row.
 */
export async function getUserActor(
  user: ActorSourceUser,
  domain: string = AP_DOMAIN,
): Promise<Record<string, unknown> | null> {
  if (!user?.username) return null;
  // Canonicalize before key lookup and actor URL assembly so `id`/`publicKey.owner`
  // always match `publicKey.id` (getUserKeyPair lowercases internally).
  const username = user.username.split('@')[0].trim().toLowerCase();
  // Null when no account holds the handle: a key is never minted ahead of its owner.
  const keyPair = await getUserKeyPair(username, domain);
  if (!keyPair) return null;

  // An ActivityPub actor's `name` field requires a non-empty string. The API no
  // longer synthesizes a display name, so fall back to the handle (`username` is
  // guaranteed here — `getUserActor` returns null above when it is absent).
  const displayName = composeDisplayName({ name: user.name }) ?? username;

  const avatar = await resolveActorAvatarUrl(user.avatar);

  return buildActor({
    domain,
    username,
    publicKeyPem: keyPair.publicKeyPem,
    keyId: keyPair.keyId,
    name: displayName,
    summary: user.bio ?? user.description ?? '',
    avatar,
    // A row's `kind` is NOT NULL, but `ActorSourceUser` accepts null so a
    // caller reading through a nullable projection needs no laundering of its
    // own. `undefined` is what `actorTypeForKind` reads as "default to Person".
    kind: user.kind ?? undefined,
    alsoKnownAs: user.alsoKnownAs ?? undefined,
  });
}
