/**
 * Recommendation scoring weight profiles and the pure resolver that merges a
 * default profile, an optional per-app profile, and caller-supplied per-request
 * overrides into the final, CLAMPED signal weights used by the scorer.
 *
 * This module is the SINGLE SOURCE OF TRUTH for every scoring constant, cap, and
 * normalization bound. It is intentionally DB-free so it can be unit-tested in
 * isolation and imported by the scorer without loading the schema.
 */

import { clamp, INFLUENCE_MIN, INFLUENCE_MAX } from './reputation.constants';

/** The scoring signals the recommendation pipeline weights. */
export type RecommendationSignal =
  | 'graph'
  | 'completeness'
  | 'verified'
  | 'curation'
  | 'interest'
  | 'appBoost'
  | 'repCandidate'
  | 'affinity';

export const RECOMMENDATION_SIGNALS: readonly RecommendationSignal[] = [
  'graph',
  'completeness',
  'verified',
  'curation',
  'interest',
  'appBoost',
  'repCandidate',
  'affinity',
] as const;

/** A resolved set of scoring weights, one per signal. */
export type RecommendationWeights = Record<RecommendationSignal, number>;

/**
 * A weight profile: the default weight for every signal plus the inclusive
 * [min, max] range each weight may be overridden into. Caller overrides are
 * clamped into this range, so a profile can both bias the defaults AND bound how
 * far a request may re-weight a signal.
 */
export interface WeightProfile {
  weights: RecommendationWeights;
  ranges: Record<RecommendationSignal, { min: number; max: number }>;
}

/** Hard bound on any scoring weight, mirroring the contract's 0..10 input cap. */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 10;

// =============================================================================
// CANDIDATE-POOL & PIPELINE CAPS
// =============================================================================

/**
 * Window of the highest-mutual-overlap candidates to pre-aggregate before
 * scoring (people followed by the people the viewer follows). Keeps the
 * mutual-count map bounded regardless of how many accounts the viewer follows.
 */
export const MUTUAL_COUNT_WINDOW = 300;

/** Max followed accounts to feed the mutual-overlap aggregation. */
export const MAX_FOLLOWING_FOR_MUTUALS = 2000;

/**
 * Hard cap on the viewer's own mutual-follow id set (`getMutualUserIds`, which
 * powers Mention's "Mutuals" feed). Bounds BOTH the following window scanned and
 * the number of ids returned, so the `$in` query and the response payload stay
 * small regardless of how many accounts the viewer follows.
 */
export const MAX_MUTUAL_IDS = 5000;

/**
 * Hard cap on the viewer's OWN following id set surfaced by the consolidated
 * viewer-graph read (`getViewerGraph`). Bounds BOTH the Follow scan and the
 * number of ids returned, so the query and payload stay small regardless of how
 * many accounts the viewer follows. Mirrors {@link MAX_MUTUAL_IDS}; the
 * most-recently-established follows are returned first when the viewer follows
 * more accounts than the cap.
 */
export const MAX_FOLLOWING_IDS = 5000;

/**
 * Hard cap on the viewer's OWN blocked id set surfaced by the consolidated
 * viewer-graph read (`getViewerGraph`). Bounds BOTH the Block scan and the
 * number of ids returned. A viewer with more blocks than the cap is a
 * pathological outlier; the cap keeps the payload bounded either way.
 */
export const MAX_BLOCKED_IDS = 5000;

/**
 * Hard cap on the viewer's "follows-of-follows" id set (`getFollowsOfFollowsIds`,
 * which SEEDS Mention's friends-of-friends feed). Bounds BOTH the viewer's own
 * following set scanned for exclusion AND the number of ids returned, so the
 * `$nin`/`$in` clauses and the response payload stay small regardless of how many
 * accounts the viewer follows.
 */
export const MAX_FOLLOWS_OF_FOLLOWS_IDS = 5000;

/**
 * Max first-hop follows sampled (most-recent first) as the seed set for the
 * second hop of `getFollowsOfFollowsIds`. Caps the fan-out: without it a viewer
 * who follows tens of thousands of accounts would scan every one of their
 * follows' following edges. The sample is the viewer's most-recent follows, so
 * the recommendation tracks their current interests.
 */
export const MAX_FOF_FIRST_HOP = 500;

/** Max app-signal candidates pulled into the candidate union per request. */
export const MAX_APP_SIGNAL_CANDIDATES = 500;

/** Upper bound on the per-viewer Redis result-cache TTL (seconds). */
export const REC_CACHE_TTL_SECONDS = 90;

// =============================================================================
// NORMALIZATION BOUNDS
// =============================================================================

/**
 * `repCandidate` is the user's denormalized `reputationRankWeight`, which lives
 * in [INFLUENCE_MIN, INFLUENCE_MAX]. It is normalized to [0, 1] across that span
 * so a floor-reputation user contributes ~0 and a capped user contributes ~1.
 */
export const REP_WEIGHT_NORM_MIN = INFLUENCE_MIN;
export const REP_WEIGHT_NORM_MAX = INFLUENCE_MAX;

/**
 * Saturation point for the endorsement roll-up: `endorsementScore` is normalized
 * to [0, 1] by dividing by this value and clamping, so a single strong endorser
 * does not dominate while a well-endorsed account saturates near 1.
 */
export const ENDORSEMENT_SCORE_SATURATION = 10;

/** Saturation point for mutual-connection overlap, normalized to [0, 1]. */
export const MUTUAL_COUNT_SATURATION = 20;

// =============================================================================
// INTERACTION-AFFINITY GRAPH (Fase 2 — direct affinity)
// =============================================================================
//
// Consuming apps report directed interaction events (`POST /app-signals/events`)
// which are folded into per-app, time-decayed directed affinity edges
// (`fromUserId → toUserId`). The scorer reads the viewer's strongest edges,
// decays each once more on read, normalizes to [0, 1], and adds
// `w.affinity * affinityScore` to the composite. With no edges the map is empty
// → 0 contribution → strict no-op.

/**
 * Exponential-decay half-life for stored affinity, in milliseconds (30 days).
 * After one half-life an untouched edge's affinity has halved; the same decay is
 * applied on the ingest read-modify-write and again on the scorer's read, so
 * affinity always reflects RECENT interaction, not lifetime totals.
 */
export const AFFINITY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Per-type default event weight applied when a caller does not override it. A
 * stronger, more intentional interaction (following, replying, quoting) carries
 * more affinity than a passive one (a profile view). These are the ADDITIVE
 * strengths folded into the (already-decayed) edge on each event.
 */
export const AFFINITY_EVENT_WEIGHTS: Readonly<Record<string, number>> = {
  follow: 5,
  reply: 4,
  quote: 4,
  boost: 3,
  repost: 3,
  mention: 3,
  like: 2,
  profile_view: 1,
} as const;

/**
 * Saturation point for the decayed affinity roll-up: an edge's decayed affinity
 * is normalized to [0, 1] by dividing by this value and clamping, so a single
 * viewer→candidate relationship saturates near 1 after sustained interaction
 * while a one-off interaction contributes a small fraction. Mirrors the
 * endorsement/mutual saturation model so all signals share the same [0, 1] scale.
 */
export const AFFINITY_SATURATION = 20;

/**
 * How many of the viewer's strongest affinity edges to pull into the candidate
 * union / affinity map per request. Bounds the injected-candidate fan-out and
 * the in-memory map, mirroring `MAX_APP_SIGNAL_CANDIDATES`.
 */
export const MAX_AFFINITY_CANDIDATES = 300;

/**
 * TTL (seconds) for the bounded `AppAffinityEventSeen` idempotency ledger — the
 * window within which a repeated `eventId` is deduped. 30 days matches the decay
 * half-life: an event delivered again after this window has negligible affinity
 * impact anyway, so folding it once more is harmless and the ledger stays small.
 */
export const AFFINITY_EVENT_SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Pure exponential time-decay of a stored affinity value.
 *
 * `decayed = stored * 2^(-elapsed / halfLife)` where `elapsed = now - lastEventAt`.
 * Guarantees:
 *  - `elapsed <= 0` (or a missing/invalid `lastEventAt`) → returns `stored`
 *    unchanged (never amplifies; clock skew cannot inflate affinity),
 *  - `elapsed === halfLife` → exactly `stored / 2`,
 *  - strictly monotonically decreasing in `elapsed` for a positive `stored`.
 *
 * Pure and DB-free — `now`/`lastEventAt` are supplied by the caller (the API
 * service passes real `Date.now()`).
 */
export function decayAffinity(
  stored: number,
  lastEventAt: Date | number | null | undefined,
  now: number,
  halfLifeMs: number = AFFINITY_HALF_LIFE_MS,
): number {
  if (!Number.isFinite(stored) || stored === 0) {
    return 0;
  }
  if (lastEventAt === null || lastEventAt === undefined || halfLifeMs <= 0) {
    return stored;
  }
  const last = lastEventAt instanceof Date ? lastEventAt.getTime() : lastEventAt;
  if (!Number.isFinite(last)) {
    return stored;
  }
  const elapsed = now - last;
  if (elapsed <= 0) {
    return stored;
  }
  return stored * Math.pow(2, -elapsed / halfLifeMs);
}

/**
 * The additive weight to fold for one interaction event: a finite, non-negative
 * caller override when supplied, else the per-type default (0 for an unknown
 * type, so a future/unrecognized type is a harmless no-op rather than a throw).
 */
export function affinityEventWeight(type: string, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override;
  }
  return AFFINITY_EVENT_WEIGHTS[type] ?? 0;
}

/** Normalize a decayed affinity value to [0, 1] against the saturation cap. */
export function normalizeAffinity(decayed: number): number {
  if (!Number.isFinite(decayed) || decayed <= 0 || AFFINITY_SATURATION <= 0) {
    return 0;
  }
  return clamp(decayed / AFFINITY_SATURATION, 0, 1);
}

/** Default weight profile applied to every app unless one overrides it. */
export const DEFAULT_WEIGHT_PROFILE: WeightProfile = {
  weights: {
    graph: 3,
    completeness: 1,
    verified: 1.5,
    curation: 2,
    interest: 1.5,
    appBoost: 2,
    repCandidate: 2,
    // Direct interaction affinity sits between graph (structural follow overlap)
    // and interest (app-reported topical interest): a real, decayed relationship
    // is a strong "who to recommend" signal, but not so strong it swamps the
    // structural graph. A no-op until events flow (empty edge map → 0).
    affinity: 2.5,
  },
  ranges: {
    graph: { min: 0, max: 6 },
    completeness: { min: 0, max: 4 },
    verified: { min: 0, max: 4 },
    curation: { min: 0, max: 5 },
    interest: { min: 0, max: 5 },
    appBoost: { min: 0, max: 6 },
    repCandidate: { min: 0, max: 6 },
    affinity: { min: 0, max: 6 },
  },
};

/**
 * Per-app weight profiles keyed by Application `_id`. Mention's app id is read
 * from `MENTION_APPLICATION_ID` (the only app with a bespoke profile today);
 * when the env var is unset no app-specific profile is registered and every
 * caller falls back to {@link DEFAULT_WEIGHT_PROFILE}.
 */
export function buildWeightProfiles(): Record<string, WeightProfile> {
  const profiles: Record<string, WeightProfile> = {};

  const mentionAppId = process.env.MENTION_APPLICATION_ID;
  if (mentionAppId) {
    profiles[mentionAppId] = {
      // Mention is graph-, affinity- and curation-led: who you follow, who you
      // actually interact with, and who curators (lists / starter packs) endorse
      // matter more than raw verification.
      weights: {
        graph: 4,
        completeness: 1,
        verified: 1,
        curation: 3,
        interest: 2,
        appBoost: 2,
        repCandidate: 2.5,
        // Mention weights real interaction affinity a notch above the default —
        // in a social app "who you engage with" is one of the strongest
        // discovery signals, second only to the raw follow graph.
        affinity: 3.5,
      },
      ranges: {
        graph: { min: 0, max: 6 },
        completeness: { min: 0, max: 4 },
        verified: { min: 0, max: 4 },
        curation: { min: 0, max: 6 },
        interest: { min: 0, max: 6 },
        appBoost: { min: 0, max: 6 },
        repCandidate: { min: 0, max: 6 },
        affinity: { min: 0, max: 6 },
      },
    };
  }

  return profiles;
}

/**
 * Resolve the final scoring weights for a request.
 *
 * Precedence: default profile → per-app profile (by `clientId` = Application
 * `_id`) → caller `signalWeights` overrides. Each caller override is CLAMPED to
 * the resolved profile's per-signal [min, max] range, so a request can re-weight
 * a signal but never escape the profile's bounds. An unknown `clientId` silently
 * resolves to the default profile.
 */
export function resolveWeightProfile(
  clientId?: string,
  overrides?: Partial<Record<RecommendationSignal, number>>,
): RecommendationWeights {
  const profiles = buildWeightProfiles();
  const profile = (clientId && profiles[clientId]) || DEFAULT_WEIGHT_PROFILE;

  const resolved: RecommendationWeights = { ...profile.weights };

  if (overrides) {
    for (const signal of RECOMMENDATION_SIGNALS) {
      const override = overrides[signal];
      if (typeof override === 'number' && Number.isFinite(override)) {
        const { min, max } = profile.ranges[signal];
        resolved[signal] = clamp(override, min, max);
      }
    }
  }

  return resolved;
}

/** Normalize a denormalized reputation rank weight to [0, 1]. */
export function normalizeRepWeight(rankWeight: number): number {
  const span = REP_WEIGHT_NORM_MAX - REP_WEIGHT_NORM_MIN;
  if (span <= 0) return 0;
  return clamp((rankWeight - REP_WEIGHT_NORM_MIN) / span, 0, 1);
}

export { INFLUENCE_MIN, INFLUENCE_MAX };
