/**
 * The single builder of a LOCAL user's ActivityPub actor document.
 *
 * Shared by the GET actor route (which serves it as a standalone JSON-LD
 * document) and the outbound `Update` broadcast (which embeds it in an
 * `Update` activity), so a follower's Mastodon renders the same actor whether it
 * was fetched or pushed. Deliberately does NOT include the top-level `@context`:
 * the GET route and the `Update` envelope each own their JSON-LD context, and an
 * embedded actor object must not double-declare it.
 *
 * The exact bytes of this document are load-bearing — Mastodon negative-caches a
 * malformed actor — so the field set, ordering, and the absolute-URL invariant on
 * `icon`/`image` must stay byte-identical across every app that uses the engine.
 *
 * Media resolution is injected ({@link ActorMediaResolver}): the engine holds no
 * knowledge of any app's media pipeline. The app resolves an avatar/banner
 * reference (Oxy file id or URL) to a final absolute URL; the engine enforces the
 * absolute-URL invariant and assembles the AP `Image` object.
 */

import { type AccountKind, isAccountKind } from '@oxyhq/contracts';
import type { UrlBuilders } from './urls';

/**
 * The five actor types AS2 defines — the vocabulary for RECOGNIZING any actor,
 * local or remote, as opposed to {@link LocalActorType} (the subset we emit).
 *
 * An inbound `Update` carrying a profile is dispatched on this: gating it on a
 * hand-written subset is how a receiver silently stops applying profile edits
 * from a whole class of account (a Lemmy community is a `Group`), with no error
 * anywhere — the edit simply never lands.
 */
export const AP_ACTOR_TYPES = [
  'Application',
  'Group',
  'Organization',
  'Person',
  'Service',
] as const;

/** Any AS2 actor type. */
export type ApActorType = (typeof AP_ACTOR_TYPES)[number];

/** Whether an untrusted inbound `type` names an AS2 actor. */
export function isApActorType(value: unknown): value is ApActorType {
  return typeof value === 'string' && (AP_ACTOR_TYPES as readonly string[]).includes(value);
}

/**
 * The AS2 actor types this engine will announce for a LOCAL user actor.
 *
 * Narrower than AS2's five actor types, and narrow ON PURPOSE — the union names
 * what the builder can emit, so the two absences are documented decisions rather
 * than oversights. Both were checked against real receiving implementations
 * (mastodon `a3649295`, lemmy `4ce92433`, misskey `b95e4841`, peertube
 * `fe0da961`), not against the spec:
 *
 *  - **`Application`** is the INSTANCE actor's type (see the actor router's
 *    `/ap/users/instance` branch), reserved by convention for the software
 *    itself. No account is the software.
 *  - **`Group`** is refused because in the deployed fediverse it is not read as
 *    "a collective of actors" but as a FORWARDING actor, and the two failure
 *    modes are concrete. Lemmy reclassifies a remote `Group` as a COMMUNITY:
 *    it is followable and the Follow is Accepted, so it looks like it worked,
 *    and then it never shows a single post — we emit no `Announce`, and our
 *    Notes do not resolve to a community. PeerTube is worse and louder: it
 *    REJECTS a `Group` actor outright unless it carries `attributedTo` naming a
 *    `Person`. An Oxy account authors its own posts and forwards nothing, so
 *    `Group` would advertise a protocol this engine does not implement.
 */
export type LocalActorType = Extract<ApActorType, 'Person' | 'Organization' | 'Service'>;

/**
 * Oxy account kind → the AS2 actor type the fediverse is told about it.
 *
 * `satisfies Record<AccountKind, LocalActorType>` is the load-bearing part: a
 * kind added to `@oxyhq/contracts` fails THIS build rather than silently
 * inheriting `Person`, which is how every non-person account came to describe
 * itself as an individual human in the first place.
 *
 * Per kind, and why:
 *
 *  - **`personal` → `Person`.** The only kind that is a human login. Unchanged.
 *  - **`organization` → `Organization`.** AS2 has the exact word.
 *  - **`project` → `Organization`.** Least-wrong of the three available: a
 *    project is a collective endeavour, not an individual (`Person`) and not an
 *    automated one (`Service`).
 *  - **`bot` → `Service`.** Not merely AS2's word for automation — it is
 *    literally the value Mastodon writes when a local user ticks "this is an
 *    automated account" (`account.rb:224`), so it is the same claim its own
 *    users make about themselves. An Oxy `bot` announcing itself as a `Person`
 *    is false, and readers specifically want it labelled.
 *  - **`channel` → `Organization`.** A channel is a CONTENT identity that can
 *    never be logged into and takes no replies, so `Person` is false about it.
 *    `Group` would promise forwarding (above). `Service` was the tempting answer
 *    and is the WRONG one: it is the automation claim, and a channel is curated
 *    by people. Mastodon's `bot?` is exactly `%w(Application Service)`
 *    (`account.rb:90`), which paints an **"Automated"** badge with a robot icon
 *    (`badges.tsx:69`), drops the account from `SimilarProfilesSource`
 *    (`similar_profiles_source.rb:22-36`), and makes its notifications
 *    discardable by policy; Lemmy sets `bot_account = true`, hiding it from
 *    anyone who turned bots off. `Organization` costs NOTHING measurable: it is
 *    accepted by all four implementations' whitelists and compared in none of
 *    them — neither `bot?` nor `group?` in Mastodon, `bot_account = false` in
 *    Lemmy, `isBot` false in Misskey, an ordinary account in PeerTube.
 *
 * What this does NOT do: it does not stop a remote instance offering a reply box
 * under a channel's post. NO actor type gates that in any of the four — Mastodon
 * has no `canReply` at all (only `canQuote` and `canFeature`) — and AS2 has no
 * interaction-policy field deployed software honours. A reply to a channel is
 * still accepted by the sender's own instance and still dropped on arrival here.
 * This map only stops asserting personhood about things that are not people.
 */
export const LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND = {
  personal: 'Person',
  organization: 'Organization',
  project: 'Organization',
  bot: 'Service',
  channel: 'Organization',
} as const satisfies Record<AccountKind, LocalActorType>;

/**
 * The AS2 actor type for an Oxy account kind, defaulting to `Person`.
 *
 * Takes `unknown` rather than `AccountKind` on purpose: the value arrives in an
 * Oxy API response, so the static type is a claim about the wire that the wire
 * can break. A deployment whose API knows a kind this package does not would
 * index a miss and emit `type: undefined` — a MALFORMED actor, which Mastodon
 * negative-caches for minutes to hours. `isAccountKind` (contracts' own narrowing,
 * so it cannot drift from the vocabulary) sends an unrecognized or absent kind to
 * `Person`: a valid actor, and the value every actor carried before this map
 * existed.
 */
export function localActorTypeForAccountKind(kind: unknown): LocalActorType {
  return isAccountKind(kind) ? LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND[kind] : 'Person';
}

/** Map common image extensions to a MIME type for an actor image `mediaType`. */
const IMAGE_MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** True when `value` is an absolute `http(s)` URL. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    return /^https?:$/i.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Build an ActivityPub `Image` object from an already-absolute URL, deriving
 * `mediaType` from the URL extension when recognizable (a bare `Image` with a
 * `url` is spec-valid, so an unknown extension simply omits `mediaType` rather
 * than asserting a wrong one). Shared by the actor `icon` (avatar) and `image`
 * (profile banner) builders.
 */
function apImageObject(url: string): { type: 'Image'; url: string; mediaType?: string } {
  let extension: string | undefined;
  try {
    extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
  } catch {
    extension = url.split('?')[0]?.split('.').pop()?.toLowerCase();
  }
  const mediaType = extension ? IMAGE_MEDIA_TYPE_BY_EXT[extension] : undefined;
  return mediaType ? { type: 'Image', url, mediaType } : { type: 'Image', url };
}

/**
 * App-supplied media resolution for the actor `icon`/`image`. Each function
 * resolves a stored reference (Oxy file id or URL) to a FINAL, ready-to-serve
 * URL, or a falsy value when there is nothing to resolve. The engine enforces the
 * absolute-URL invariant on the result.
 */
export interface ActorMediaResolver {
  /** Resolve the avatar reference to an absolute URL (actor `icon`). */
  resolveAvatar(ref: string): string | null | undefined;
  /** Resolve the banner reference to an absolute URL (actor `image`). */
  resolveBanner(ref: string): string | null | undefined;
}

/** Adapters + domain config a {@link LocalActorBuilder} is built from. */
export interface LocalActorBuilderConfig {
  /** The app's federation domain — the host of the actor's human-facing `url`. */
  domain: string;
  /** The per-instance URL builders (actor/inbox/outbox/collections). */
  urls: UrlBuilders;
  /** App-supplied avatar/banner resolution. */
  media: ActorMediaResolver;
  /** Optional sink for the non-fatal "did not resolve to an absolute URL" warning. */
  onWarn?: (message: string) => void;
}

/** Per-user inputs to a {@link LocalActorBuilder}. */
export interface BuildLocalActorParams {
  username: string;
  /**
   * The account-graph classification (Oxy `User.kind`), which decides the AS2
   * actor `type` via {@link LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND}. Absent is read as
   * `personal` — matching the column's own default, and preserving the `Person`
   * every actor carried before the map existed.
   */
  kind?: AccountKind | null;
  /**
   * The caller-resolved Oxy `name.displayName` (falling back to the handle). Never
   * recomposed from name parts here.
   */
  displayName: string;
  bio?: string | null;
  /** The avatar reference (Oxy file id or URL); resolved to the actor `icon`. */
  avatar?: string | null;
  /**
   * The banner reference (from the app's own settings, e.g.
   * `UserSettings.profileHeaderImage`); resolved to the actor `image`.
   */
  profileHeaderImage?: string | null;
  publicKey: { keyId: string; publicKeyPem: string };
  createdAt?: string | null;
}

/**
 * Assembles a LOCAL user's AP actor object (WITHOUT the top-level `@context`).
 * The actor `type` follows the account's kind — see
 * {@link LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND}.
 */
export type LocalActorBuilder = (params: BuildLocalActorParams) => Record<string, unknown>;

/**
 * Build the actor `icon` (avatar) object, enforcing the absolute-URL invariant.
 *
 * ActivityPub consumers such as Mastodon validate that `icon.url` is an absolute
 * URL and REJECT the entire actor document when it is not — so a non-absolute
 * value makes the account undiscoverable. Returns undefined when there is no
 * avatar or no absolute URL can be produced (Mastodon is fine with an
 * avatar-less actor).
 */
function buildActorIcon(
  config: LocalActorBuilderConfig,
  avatar: string | null | undefined,
): { type: 'Image'; url: string; mediaType?: string } | undefined {
  if (!avatar) return undefined;
  const resolved = config.media.resolveAvatar(avatar);
  if (!resolved || !isAbsoluteHttpUrl(resolved)) {
    config.onWarn?.(`[Federation] Omitting actor icon — avatar did not resolve to an absolute URL (ref: ${avatar})`);
    return undefined;
  }
  return apImageObject(resolved);
}

/**
 * Build the actor `image` (profile banner/header) object, enforcing the same
 * absolute-URL invariant as {@link buildActorIcon}. Mastodon renders the AP
 * `image` property as the profile HEADER banner.
 */
function buildActorImage(
  config: LocalActorBuilderConfig,
  banner: string | null | undefined,
): { type: 'Image'; url: string; mediaType?: string } | undefined {
  if (!banner) return undefined;
  const resolved = config.media.resolveBanner(banner);
  if (!resolved || !isAbsoluteHttpUrl(resolved)) {
    config.onWarn?.(`[Federation] Omitting actor image — banner did not resolve to an absolute URL (ref: ${banner})`);
    return undefined;
  }
  return apImageObject(resolved);
}

/**
 * Build the per-instance local-actor builder. Bind it once with an app's domain +
 * media resolver; call the returned function per user.
 */
export function createLocalActorBuilder(config: LocalActorBuilderConfig): LocalActorBuilder {
  return (params: BuildLocalActorParams): Record<string, unknown> => {
    const { username, displayName, kind, bio, avatar, profileHeaderImage, publicKey, createdAt } = params;

    const actorObject: Record<string, unknown> = {
      id: config.urls.actor(username),
      type: localActorTypeForAccountKind(kind),
      preferredUsername: username,
      name: displayName,
      summary: bio || '',
      url: `https://${config.domain}/@${username}`,
      inbox: config.urls.inbox(username),
      outbox: config.urls.outbox(username),
      featured: config.urls.featured(username),
      followers: config.urls.followers(username),
      following: config.urls.following(username),
      endpoints: { sharedInbox: config.urls.sharedInbox() },
      discoverable: true,
      manuallyApprovesFollowers: false,
      icon: buildActorIcon(config, avatar),
      image: buildActorImage(config, profileHeaderImage),
      publicKey: {
        id: publicKey.keyId,
        owner: config.urls.actor(username),
        publicKeyPem: publicKey.publicKeyPem,
      },
    };

    // `published` (account creation date) is advertised when the API provides it.
    if (createdAt) {
      actorObject.published = new Date(createdAt).toISOString();
    }

    return actorObject;
  };
}
