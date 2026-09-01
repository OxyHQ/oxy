/**
 * Domain-parameterized ActivityPub URL builders.
 *
 * Every Oxy app federates under its OWN domain (`@user@mention.earth`,
 * `@user@homiio.com`, `@user@oxy.so`), so the actor/inbox/outbox/collection URLs
 * an app mints must be scoped to that app's instance — never a module-level
 * constant. {@link createUrlBuilders} is the factory each app instantiates once
 * with its `FEDERATION_DOMAIN` (and, optionally, a distinct `ACTOR_DOMAIN`); the
 * returned builders produce the exact URL shapes Mastodon and the rest of the
 * fediverse expect, byte-for-byte identical to the strings the actor document
 * advertises.
 *
 * `actor()` is scoped to `actorDomain` (the host in the actor `id` / `publicKey`
 * owner) while every other builder is scoped to `domain`; in the common case both
 * are the same host. The two are kept separate so a deployment that serves the
 * actor namespace from a different host than the webfinger/inbox host can still
 * advertise a self-consistent actor.
 */

/** The per-instance ActivityPub URL builders, scoped to one app's domain. */
export interface UrlBuilders {
  /** Actor `id` / `attributedTo` — `https://<actorDomain>/ap/users/<username>`. */
  actor(username: string): string;
  /** The actor's personal inbox. */
  inbox(username: string): string;
  /** The actor's outbox collection. */
  outbox(username: string): string;
  /** The actor's `featured` (pinned posts) collection. */
  featured(username: string): string;
  /** The actor's followers collection. */
  followers(username: string): string;
  /** The actor's following collection. */
  following(username: string): string;
  /** The instance-wide shared inbox. */
  sharedInbox(): string;
}

/**
 * Build the ActivityPub URL builders for an app instance.
 *
 * @param domain the app's federation domain (webfinger / inbox / collections host).
 * @param actorDomain the host that owns the actor `id`; defaults to `domain`.
 */
export function createUrlBuilders(domain: string, actorDomain: string = domain): UrlBuilders {
  return {
    actor: (username) => `https://${actorDomain}/ap/users/${username}`,
    inbox: (username) => `https://${domain}/ap/users/${username}/inbox`,
    outbox: (username) => `https://${domain}/ap/users/${username}/outbox`,
    featured: (username) => `https://${domain}/ap/users/${username}/collections/featured`,
    followers: (username) => `https://${domain}/ap/users/${username}/followers`,
    following: (username) => `https://${domain}/ap/users/${username}/following`,
    sharedInbox: () => `https://${domain}/ap/inbox`,
  };
}

/**
 * The reserved local-part of the instance-wide server actor (`Application`).
 *
 * This actor signs the engine's own outbound GETs; it is NOT an Oxy user, has no
 * profile page and no fediverse-sharing consent record. Both the actor route and
 * the WebFinger route must answer for it, and Mastodon compares the WebFinger
 * `self` href against the actor `id` byte-for-byte before it will trust a signed
 * fetch — so the two routers derive that URL from THIS constant through the same
 * {@link UrlBuilders.actor} builder rather than each spelling the name themselves.
 */
export const INSTANCE_ACTOR_USERNAME = 'instance';

/** Normalize a local actor username from a path segment or WebFinger acct local-part. */
export function normalizeActorUsername(username: string): string {
  return username.trim().toLowerCase();
}
