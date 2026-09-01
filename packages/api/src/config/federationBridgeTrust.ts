/**
 * WHICH BRIDGE HOSTS THIS API WILL LET A SERVICE RE-ATTRIBUTE AN ACCOUNT TO.
 *
 * `PUT /users/resolve` binds a federated actor's URI host to the domain the
 * caller asserts, so a service cannot claim to vouch for a user on a host it does
 * not own. A BRIDGE is the one case where the two legitimately differ: an account
 * republished at `@wired@some-bridge.example` is WIRED on X, and its identity
 * belongs to the network rather than to the host the copy arrived through.
 * WebFinger cannot settle that — X publishes none, and no amount of asking the
 * bridge would make it authoritative for `x.com`.
 *
 * WHY THIS LIST IS *HERE* AND NOT IN `@oxyhq/federation`
 *
 *   Deciding that a given operator may be trusted to re-attribute somebody's
 *   account is a moderation judgement, not a platform fact. Putting it in the
 *   shared package would hand every Oxy app that imports the package a trust
 *   decision its owner never made. So the package ships the MECHANISM and this
 *   service ships its own policy — the same division the blocklist uses: Oxy
 *   holds a capability, never a policy.
 *
 * WHY IT IS NOT THE CALLING APP'S LIST EITHER
 *
 *   The whole point of the host binding is that it is not the caller's decision.
 *   A connector DERIVES a bridged identity; this endpoint ADJUDICATES it. An
 *   adjudicator that reads the applicant's own list is not adjudicating — it is
 *   taking their word, which is exactly the impersonation vector the binding
 *   exists to close.
 *
 * ⚠ THE SECOND LIST IS NOT DUPLICATION. DO NOT CONSOLIDATE THEM.
 *
 *   A reader who finds this file and a connector's bridge policy side by side
 *   will see two lists of the same domains and reach for the obvious tidy-up:
 *   import one from the other, or hoist both into the shared package. Doing that
 *   silently deletes the property that makes this safe.
 *
 *   Kept separate, drift between the two FAILS CLOSED in BOTH directions:
 *
 *     app lists a bridge this file does not   → resolve refused; the actor
 *                                               simply keeps its bridge identity
 *     this file lists one no app derives for  → nothing happens at all
 *
 *   Neither direction can produce an ACCEPTED ATTRIBUTION NOBODY REVIEWED, which
 *   is the failure both halves of this design exist to prevent. Consolidate them
 *   and one side's list becomes the other's authority, so a single unreviewed
 *   entry — in either repository — starts re-attributing real people's writing.
 *   The redundancy is the safety mechanism, not an oversight.
 *
 * A wrong entry attributes one person's writing to another, which is heavier than
 * a wrong block, so an entry states what was verified about the operator and when
 * it was reviewed. Matching is exact canonical-host membership — a subdomain is a
 * different server and needs its own reviewed entry.
 *
 * This list answers ONLY whether a bridge host may vouch for a network domain
 * at resolve time. Whether an app actually re-labels ingested actors (`relabel:
 * 'enabled' | 'pending_dedup'`) is a separate decision on the app's bridge
 * entries — API trust does not gate relabel timing.
 *
 * FOLLOW-UP: the properly Oxy-shaped version of this is a staff-granted
 * `Application` capability (see `utils/applicationCapabilities.ts`) that lets a
 * registered app assert bridged identities, replacing the host list entirely.
 * That widens what a compromised credential could claim, so it wants its own
 * review rather than being folded into this change.
 */

import { canonicalFederationHost } from '@oxyhq/federation';

/** One reviewed bridge host and the single network it is trusted to vouch for. */
export interface FederationBridgeTrustEntry {
  /** Canonical host — lowercase, bare, no scheme, no `www.`. */
  readonly host: string;
  /** The network domain this host may assert as a federated identity's domain. */
  readonly networkDomain: string;
  /** What was verified about the operator, in one sentence. */
  readonly reason: string;
  /** `YYYY-MM-DD` — the day the entry was reviewed. */
  readonly since: string;
}

/**
 * THE COMMITTED TRUST LIST.
 *
 * The BirdsiteLive family is enumerated rather than pattern-matched on software
 * name: the software is self-hostable, so "runs BirdsiteLive" is a claim any host
 * can make about itself and is not a reason to believe its attributions.
 */
export const FEDERATION_BRIDGE_TRUST: readonly FederationBridgeTrustEntry[] = [
  {
    host: 'bird.makeup',
    networkDomain: 'x.com',
    reason: 'BirdsiteLive mirror of X accounts; each actor publishes a rel="me" link to the X profile it mirrors.',
    since: '2026-08-02',
  },
  {
    host: 'kilogram.makeup',
    networkDomain: 'instagram.com',
    reason: 'BirdsiteLive mirror of Instagram accounts by the bird.makeup operator; same rel="me" backlink.',
    since: '2026-08-02',
  },
  {
    host: 'mastox.eu',
    networkDomain: 'x.com',
    reason: 'Mastodon instance that exists to mirror X accounts, declared as such by its operator; mirrored actors carry a per-account bot notice.',
    since: '2026-08-02',
  },
  {
    host: 'bsky.brid.gy',
    networkDomain: 'bsky.social',
    reason: 'Bridgy Fed opt-in Bluesky bridge; each actor carries its atproto DID in alsoKnownAs and a rel="me" link to its bsky.app profile.',
    since: '2026-08-02',
  },
];

const TRUSTED_BY_HOST: ReadonlyMap<string, string> = new Map(
  FEDERATION_BRIDGE_TRUST.map((entry) => [
    canonicalFederationHost(entry.host),
    canonicalFederationHost(entry.networkDomain),
  ]),
);

/**
 * Whether `actorHost` is a reviewed bridge this API trusts to vouch for
 * `networkDomain`.
 *
 * Both halves must match. A bridge mirrors ONE network, so being on the list is
 * never on its own a licence to claim any domain — otherwise a single trusted
 * host could re-attribute accounts to every network at once.
 */
export function bridgeVouchesForNetwork(actorHost: string, networkDomain: string): boolean {
  const trusted = TRUSTED_BY_HOST.get(canonicalFederationHost(actorHost));
  return trusted !== undefined && trusted === canonicalFederationHost(networkDomain);
}
