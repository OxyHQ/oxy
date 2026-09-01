/**
 * @oxyhq/federation — the app-agnostic federation substrate (isomorphic `.` entry).
 *
 * The pluggable network-connector CONTRACT and the normalized, cross-network
 * DTOs every connector produces. An app's content/MTN core never knows about
 * Mastodon (ActivityPub) or Bluesky (atproto); it only ever talks to a
 * {@link NetworkConnector}. This module is that seam: the normalized DTOs every
 * connector produces, the local-event union connectors deliver outbound, and
 * the connector interface itself.
 *
 * IMPORTANT: this entry is intentionally free of Mongoose / Express / React
 * Native so it can be imported from any Oxy app backend (and, in later phases,
 * share the pure HTTP-signature + actor-object surface with browser/isomorphic
 * callers). The runnable Express/Node engine — signed fetch, delivery transport,
 * webfinger/actor/inbox routers, remote-actor resolution — lives under the
 * separate `./node` subpath so it never enters isomorphic bundles.
 *
 * The one piece of app-specific data that flows through the outbound seam — a
 * local post's canonical content — is a TYPE PARAMETER (`TContent`), supplied by
 * the consuming app (Mention passes its `PostContent`). The engine holds no
 * knowledge of any app's post shape.
 */

/**
 * HTTP Signatures (draft-cavage) — the pure sign/verify crypto every Oxy app's
 * ActivityPub federation shares. Private-key custody is injected; the key never
 * enters this package.
 */
export {
  signRequest,
  verifyHttpSignature,
  HTTP_SIGNATURE_ALGORITHM,
  DEFAULT_SIGNED_CONTENT_TYPE,
  type HttpSignatureSigner,
  type SignRequestOptions,
  type VerifyHttpRequest,
  type VerifyHttpResult,
  type FetchPublicKey,
  type VerifyHttpSignatureOptions,
} from './httpSignature';

/**
 * Domain-parameterized ActivityPub URL builders — each app instantiates them once
 * with its own `FEDERATION_DOMAIN` so every actor stays `@user@its-own-domain`.
 */
export { createUrlBuilders, normalizeActorUsername, INSTANCE_ACTOR_USERNAME, type UrlBuilders } from './urls';

/**
 * Network identity: the MECHANISM for re-labelling an account republished by a
 * bridge onto the network it actually came from, plus the network vocabulary and
 * the bidirectional upstream-profile-URL rule.
 *
 * The mechanism is here; the ENTRIES are not, and must not be. Which operators
 * may be trusted to re-attribute somebody's account is a moderation judgement an
 * app commits and answers for — `createBridgeRelabeller` takes them as a
 * parameter so no app inherits another's.
 */
export {
  FEDERATION_NETWORKS,
  BSKY_NETWORK_DOMAIN,
  blueskyUsernameFromHandle,
  createBridgeRelabeller,
  stripBridgeBoilerplate,
  upstreamProfileUrl,
  parseUpstreamProfileUrl,
  federatedUsernameFromUpstreamUrl,
  upstreamHandleFromProfileField,
  upstreamHandleFromAlsoKnownAs,
  upstreamHandleFromAutomatedActor,
  upstreamHandleFromPreferredUsername,
  upstreamHandleFromProxyOf,
  readProxyDeclarations,
  type FederationNetwork,
  type FederationBridgeEntry,
  type BridgeRelabeller,
  type BridgeConsentModel,
  type BridgeDerivation,
  type BridgedActorField,
  type DeriveNetworkIdentity,
  type NetworkIdentity,
  type NetworkIdentityCandidate,
  type ProxyDeclaration,
} from './networkIdentity';

/**
 * The shared JSON-LD `@context` (load-bearing term declarations) and the
 * ActivityPub URI helpers (actor-uri extraction + the per-instance domain policy:
 * blocked-domain check + local-post-id extraction).
 *
 * `canonicalFederationHost` / `isSameFederationHost` are exported because the
 * domain policy is not the only thing that has to decide whether two spellings
 * are the same host: a moderation blocklist, a transparency page and a content
 * purge all ask the same question about the same hosts, and any of them keeping
 * its own copy of the rule is a second opinion waiting to diverge from the one
 * the engine enforces. They are the very functions {@link createDomainPolicy} is
 * built from — not a parallel implementation that agrees today.
 */
export { AP_CONTEXT } from './apContext';
export {
  canonicalFederationHost,
  isSameFederationHost,
  extractActorUriFromActivityId,
  createDomainPolicy,
  type DomainPolicy,
  type DomainPolicyConfig,
} from './apUri';

/**
 * The single builder of a LOCAL user's ActivityPub actor document —
 * byte-identical across apps, with media resolution injected. The actor `type`
 * follows the Oxy account kind ({@link LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND}).
 */
export {
  createLocalActorBuilder,
  localActorTypeForAccountKind,
  isApActorType,
  AP_ACTOR_TYPES,
  LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND,
  type ApActorType,
  type LocalActorType,
  type LocalActorBuilder,
  type LocalActorBuilderConfig,
  type BuildLocalActorParams,
  type ActorMediaResolver,
} from './actorObject';

/** Supported external networks. */
export type NetworkId = 'activitypub' | 'atproto';

/**
 * A remote actor normalized into a network-neutral shape. Built by a connector
 * from its protocol's profile representation, and consumed by the identity
 * bridge ({@link NetworkConnector.mapIdentity}) to resolve/mint the federated
 * Oxy user the actor maps to.
 */
export interface NormalizedExternalActor {
  network: NetworkId;
  /** Stable protocol id: an ActivityPub actor URI, or an atproto DID. */
  externalId: string;
  /** Fediverse-style handle (`user@domain` for AP; the atproto handle/DID otherwise). */
  handle: string;
  /**
   * The canonical `local@domain` username this actor is stored under in Oxy — the
   * exact value passed to `PUT /users/resolve`. Each connector derives it for its
   * own protocol so the shared identity bridge never has to guess: AP uses the
   * acct (`user@domain`); atproto synthesizes `<username>@<instance-domain>`, where
   * a default Bluesky handle drops the redundant `.bsky.social` suffix
   * (`skylee1.bsky.social` → `skylee1@bsky.social`) and a custom domain keeps its
   * whole handle (`mayor.nyc.gov` → `mayor.nyc.gov@bsky.social`). It MUST equal
   * `instanceDomain` after the `@` so oxy-api's username↔domain binding holds.
   */
  federatedUsername: string;
  /**
   * The instance/origin domain this actor's identity belongs to — the `domain`
   * passed to `PUT /users/resolve` and stamped on imported `Post.instanceDomain`.
   * AP: the actor host (e.g. `mastodon.social`); atproto: the handle's parent
   * domain (e.g. `bsky.social`), since a DID carries no host.
   */
  instanceDomain: string;
  displayName?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio?: string;
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  /** The Oxy user this actor resolves to, once known. */
  oxyUserId?: string;
}

/** A single media item on a normalized external post (mirrors the Post media shape). */
export interface NormalizedExternalMedia {
  id: string;
  type: 'image' | 'video';
  remoteUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  orientation?: 'portrait' | 'landscape' | 'square';
  aspectRatio?: number;
}

/**
 * A remote post normalized into a network-neutral shape. Mirrors the
 * `Post.federation` provenance block plus the author and media a connector
 * resolves while importing it.
 */
export interface NormalizedExternalPost {
  network: NetworkId;
  /** Globally-unique provenance id (AP activity/object id, or atproto at:// URI). */
  activityId: string;
  /** Authoring actor's protocol id (AP actor URI / atproto DID). */
  actorUri: string;
  url?: string;
  inReplyTo?: string;
  sensitive?: boolean;
  spoilerText?: string;
  /** Resolved Oxy author, when the actor already maps to an Oxy user. */
  authorOxyUserId?: string;
  text: string;
  media?: NormalizedExternalMedia[];
  hashtags?: string[];
  /**
   * Resolved @mention Oxy user ids — the stored `mentions` allowlist, keyed by the
   * `[mention:<id>]` placeholders the connector rewrote into {@link text}.
   */
  mentions?: string[];
  /**
   * The quoted post's external URI (an atproto `at://` URI / an AP quote uri) when
   * this post quotes another. Resolved to a local `quoteOf` Post id at import time
   * by matching an imported post's `federation.activityId`; left unresolved (no
   * quote link) when the quoted post is not imported locally.
   */
  quotedUri?: string;
  language?: string;
  languages?: string[];
  createdAt?: Date;
}

/** Options for paging a connector's post fetch. */
export interface FetchPostsOptions {
  limit?: number;
  cursor?: string;
}

/** Result of a connector post fetch (opaque per-connector cursor). */
export interface FetchPostsResult {
  posts: NormalizedExternalPost[];
  cursor?: string;
}

/**
 * Local-post shape a `post.create` event carries to outbound delivery.
 *
 * `content` is the consuming app's CANONICAL post-content type (`TContent`), not
 * a trimmed-down copy: a connector needs the post's localized variants and
 * primary language to declare the post's language on the wire (ActivityPub
 * `contentMap`, atproto `langs`), and a narrowed structural type here would
 * silently DROP them at the seam. The federation package never inspects
 * `content`; it flows through untouched to the app's own connector.
 */
export interface LocalPostEventPayload<TContent = unknown> {
  _id: unknown;
  content: TContent;
  hashtags?: string[];
  mentions?: string[];
  /** The classifier's resolved primary language — the fallback when the author declared no primary tag. */
  language?: string;
  visibility: string;
  createdAt: string;
  /**
   * The boosted original's local Post `_id` when this post is a boost
   * (`type: 'boost'`). A boost carries an intentionally EMPTY body and MUST NOT
   * federate as a `Create(Note)` — the connector re-routes it to an `Announce`.
   * Preserving it through the seam is what lets `POST /posts` `boost_of` avoid
   * emitting a blank Create.
   */
  boostOf?: string | null;
  /**
   * The parent's local Post `_id` when this post is a REPLY. The connector emits
   * the Note with `inReplyTo` (the parent's canonical AP object id) + a
   * parent-author `Mention`, and unions the parent author's inbox into delivery so
   * a reply to a remote post threads and notifies its author. Preserving it through
   * the seam is what lets the `/feed/reply` path federate replies. Absent for a
   * top-level post.
   */
  parentPostId?: string | null;
}

/**
 * The minimal boost shape a `post.boost` / `post.unboost` event carries to
 * outbound delivery. A boost has no body of its own; the connector federates it
 * as an `Announce` (or `Undo(Announce)`) of the original post's canonical AP id,
 * resolved from `boostOf`. `createdAt` stamps the activity's `published`.
 */
export interface LocalBoostEventPayload {
  _id: unknown;
  boostOf: string;
  createdAt: string | Date;
}

/**
 * The minimal shape a `post.delete` event carries. A local post's canonical AP
 * object id is minted deterministically from the deleter's username + this `_id`
 * (`https://<domain>/ap/users/<username>/posts/<_id>`), so the connector needs
 * nothing more to emit a `Delete(Tombstone)`. The post row is already gone by the
 * time this fires — the id is captured BEFORE deletion.
 */
export interface LocalDeleteEventPayload {
  _id: unknown;
}

/**
 * The shape a `post.like` / `post.unlike` event carries to outbound delivery.
 * A federated-post like federates as a `Like` (or `Undo(Like)`) whose `object` is
 * the liked original's remote `federation.activityId`, resolved from `postId`, and
 * delivered ONLY to that origin author's inbox (never fanned out to followers).
 * The AP activity id is minted deterministically from the native Like doc's `_id`
 * so the `Undo` re-mints the same id without persisting it.
 */
export interface LocalLikeEventPayload {
  /** The native `Like` document `_id` — the deterministic AP Like activity id. */
  _id: unknown;
  /** The liked post's local `_id` — resolved to its canonical AP object id + author inbox. */
  postId: string;
}

/**
 * A local domain event handed to connectors for outbound delivery. Discriminated
 * by `kind`: post lifecycle (`post.create` / `post.update` / `post.delete`),
 * engagement (`post.boost` / `post.unboost` / `post.like` / `post.unlike`), actor
 * profile changes (`actor.update`), and the follow lifecycle.
 *
 * Generic over the app's post-content type `TContent`, carried by the
 * `post.create` / `post.update` payloads.
 */
export type LocalNetworkEvent<TContent = unknown> =
  | {
      kind: 'post.create';
      post: LocalPostEventPayload<TContent>;
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      kind: 'post.boost';
      boost: LocalBoostEventPayload;
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      kind: 'post.unboost';
      boost: LocalBoostEventPayload;
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      kind: 'post.update';
      post: LocalPostEventPayload<TContent>;
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      kind: 'post.delete';
      post: LocalDeleteEventPayload;
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      kind: 'post.like';
      like: LocalLikeEventPayload;
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      kind: 'post.unlike';
      like: LocalLikeEventPayload;
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      /**
       * A local user changed an actor-visible profile field OWNED by the app (e.g.
       * a `profileHeaderImage` banner). The connector rebroadcasts the FULL actor
       * document as an `Update(Person)` to remote followers so Mastodon refreshes.
       * Oxy-owned fields (displayName/avatar/bio) are NOT hooked here — they change
       * in Oxy, which has no signal into the app (see `federateActorUpdate`).
       */
      kind: 'actor.update';
      actorOxyUserId: string;
      actorUsername: string;
    }
  | {
      kind: 'follow.add';
      localOxyUserId: string;
      localUsername: string;
      targetActorUri: string;
    }
  | {
      kind: 'follow.remove';
      localOxyUserId: string;
      localUsername: string;
      targetActorUri: string;
    };

/** Context passed alongside an inbound payload to {@link NetworkConnector.receive}. */
export interface ReceiveContext {
  /** The remote actor URI/DID whose signature was already verified by the transport. */
  verifiedActorUri: string;
}

/**
 * The common contract every external network speaks behind. A connector owns all
 * protocol specifics; the registry and the app's content core only ever see this
 * surface.
 *
 * Generic over the app's post-content type `TContent`, which flows through
 * {@link NetworkConnector.deliver} on `post.create` / `post.update` events.
 */
export interface NetworkConnector<TContent = unknown> {
  /** The network this connector serves. */
  readonly id: NetworkId;
  /** Whether this connector is enabled (env-gated). Disabled connectors are skipped. */
  readonly enabled: boolean;
  /** True when `subject` (a handle / URI / DID) belongs to this network. */
  matches(subject: string): boolean;
  /** Resolve a handle to a normalized actor (webfinger for AP, handle→DID for atproto). */
  resolve(handle: string): Promise<NormalizedExternalActor | null>;
  /** Fetch + normalize an actor profile by its protocol id. */
  fetchProfile(externalId: string): Promise<NormalizedExternalActor | null>;
  /** Backfill + normalize an actor's recent posts. */
  fetchPosts(externalId: string, opts?: FetchPostsOptions): Promise<FetchPostsResult>;
  /** Deliver a local domain event outbound (federate to followers / write a record). */
  deliver(event: LocalNetworkEvent<TContent>): Promise<void>;
  /** Process an inbound payload (already actor-verified by the transport). */
  receive(payload: unknown, ctx: ReceiveContext): Promise<void>;
  /** Resolve/mint the Oxy user this external actor maps to; null when unresolvable. */
  mapIdentity(actor: NormalizedExternalActor): Promise<string | null>;
}
