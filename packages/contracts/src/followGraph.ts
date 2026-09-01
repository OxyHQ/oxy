/**
 * The follow graph wire contract (`/v2/follows`).
 *
 * These types are the boundary between the API that owns the graph and every
 * application that reads it. They live here — not in the API and not in the
 * SDK — because both ends have to agree, and a shape defined on one side is a
 * shape the other side re-declares slightly differently within a release or two.
 *
 * ## Why the state is three fields and not a boolean
 *
 * A user can follow something globally and turn it off in ONE application. That
 * is a state the user themselves created, so the client has to be able to see
 * it and say so — "following, but not shown here" is a sentence a boolean
 * cannot express. `globalState`, `applicationMode` and `effectiveState` are
 * therefore reported separately, and only the last one answers "does this
 * appear in my feed right now".
 *
 * ## Why kinds are strings
 *
 * `FollowTargetKind` is a plain `string`, not a union. Applications register
 * their own kinds at runtime (`mercaria.store`, `syra.artist`), so a union here
 * would mean every new application in the ecosystem needs a release of this
 * package before it can follow anything. The namespace rule is enforced by the
 * database, which is the one place that can enforce it for applications this
 * package has never heard of.
 */

/**
 * A registered target kind, always `<namespace>.<thing>`.
 *
 * The namespace is the owning application's, so two applications cannot define
 * or silently redefine each other's kinds.
 */
export type FollowTargetKind = string;

/**
 * Where a relationship stands globally — the user's own decision, independent
 * of any application. Mirrors the database's own enum, which is the authority.
 *
 * `requested` is a real state and not a transient one: a private account has to
 * accept, and until it does the user has asked and is waiting. A client that
 * renders it as "not following" invites a second request that changes nothing.
 */
export type FollowState = 'none' | 'requested' | 'active' | 'rejected';

/**
 * What this application should DO right now — the field a button renders.
 *
 * Note that "never followed" and "following, but switched off here" both come
 * back as `not_following`, because the answer to "does this appear in my feed"
 * is the same for both. They are still distinguishable, and a UI explaining
 * itself must distinguish them: it is `globalState === 'active'` with
 * `applicationMode === 'disabled'`.
 */
export type FollowEffectiveState = 'not_following' | 'requested' | 'following';

/**
 * What ONE application does with a relationship.
 *
 * `inherit` is the default and means "whatever the user decided globally".
 * `disabled` is the interesting one: the user still follows, this application
 * just does not act on it — which is what makes "follow everywhere, mute here"
 * possible without the user losing the follow.
 */
export type FollowApplicationMode = 'inherit' | 'enabled' | 'disabled';

/** A thing that can be followed. */
export interface FollowTarget {
  id: string;
  /**
   * The stable, global identity of the thing — an Oxy URI for local objects, an
   * ActivityPub actor URI for remote ones. What makes "the same target" the
   * same across applications and across servers.
   */
  uri: string;
  kind: FollowTargetKind;
  /**
   * A cached display snapshot (name, handle, avatar). Present so a follow list
   * can render without one lookup per row; never authoritative — the owning
   * application always holds the current version.
   */
  metadata?: Record<string, unknown>;
}

/** One row of the user's central follow list. */
export interface FollowRecord {
  relationshipId: string;
  target: FollowTarget;
  globalState: FollowState;
  applicationMode: FollowApplicationMode;
  /**
   * Whether this follow acts in the requesting application right now — the
   * same field a button renders. List rows carry it so a follow list can seed
   * `FollowTargetButton` without recomputing the server's derivation.
   */
  effectiveState: FollowEffectiveState;
  /**
   * Where the user was when they followed. Provenance for the audit trail and
   * for notification routing — never authority: this application cannot undo
   * what another one recorded.
   */
  originApplicationId: string | null;
  /** Set only on a timed follow. ISO-8601. */
  expiresAt?: string;
  createdAt: string;
}

/**
 * The three-part answer to "am I following this".
 *
 * `effectiveState` is what a button renders. The other two are what an
 * explanation renders, and a client that shows a disabled follow as "not
 * following" will be asked why the button does nothing.
 */
export interface FollowStatus {
  /** Absent when nothing has ever been followed. Every other operation needs it. */
  relationshipId?: string;
  globalState: FollowState;
  applicationMode: FollowApplicationMode;
  /** `following` only when followed globally AND not disabled here. */
  effectiveState: FollowEffectiveState;
  expiresAt?: string;
}

/**
 * `PUT /v2/follows/:targetId` — `created: false` means it already existed.
 *
 * Carries the whole resulting status rather than a couple of fields off it, so
 * a client can store the answer instead of reconstructing one. Reconstructing
 * is where an optimistic update and the settled value drift: the derivation of
 * `effectiveState` lives on the server, and a client recomputing it is a second
 * implementation of a rule that has one.
 */
export interface FollowMutation {
  relationshipId: string;
  created: boolean;
  status: FollowStatus;
}

/** `DELETE /v2/follows/:relationshipId` — `removed: false` means it was already gone. */
export interface UnfollowMutation {
  removed: boolean;
}

/** `GET /v2/me/follows` */
export interface FollowListPage {
  follows: FollowRecord[];
  /** Absent when the last page has been reached. */
  nextCursor?: string;
}

/**
 * Options for `PUT /v2/follows/:targetId`.
 *
 * `expiresIn` is the timed follow — seconds from now. Bounded server-side,
 * because an unbounded value is indistinguishable from a permanent follow the
 * user believes will end.
 */
export interface FollowOptions {
  expiresIn?: number;
}
