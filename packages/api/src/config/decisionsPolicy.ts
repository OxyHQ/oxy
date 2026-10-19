/**
 * Which model lines may answer `decisions` on `kaana.ai/v1`, and under which
 * limits: the stable, reviewed approval the grant API applies (Kaana ADR 0002;
 * `docs/inference/decisions.md`).
 *
 * ## Versioned in code, not switched by an environment variable
 *
 * The profile is reviewable data with a version string, like the economic
 * relationships (`config/inferenceEconomicPolicy.ts`). Adding, removing,
 * re-pinning or re-pricing a line is a reviewed commit that bumps
 * {@link DECISIONS_POLICY_VERSION}. There is deliberately no env switch: a line
 * a deployment variable could add is one nobody reviewed.
 *
 * ## What each part decides, and what it does not
 *
 *  - The profile is ORDERED. A decisions request that names no model is granted
 *    one step per line, in this order. Kaana tries the steps in order and moves
 *    to the next only on a skip before anything is sent, never after a provider
 *    answered. A request that names a model must name one of these lines at
 *    its revision; a power level never serves decisions.
 *  - A step is always revision-pinned: a line names the revision Kaana's
 *    publisher minted for it, and a decisions step admits no other.
 *  - A line is not a route. Kaana publishes the deployments and declares the
 *    line's identity, data policy and list price; a line with no published,
 *    sellable route is skipped, so a reviewed line can be listed here before
 *    Kaana serves it. A line enters this list only once its provider has a
 *    funded key with zero data retention.
 *  - The limits bind every step whatever the application's own policy says:
 *    zero data retention, no training on customer data, and one provider and
 *    key per line (no same-model failover), so a decision is answered by the
 *    reviewed provider or not at all.
 *  - Who may call is not here: an application needs decisions terms in its
 *    economic relationship (`pilot.decisions`), which also bound the input and
 *    the price per request.
 */

/** The version every decisions grant was admitted under; bump it on ANY change below. */
export const DECISIONS_POLICY_VERSION = 'oxy-decisions/2026-10-19.1';

/** One pinned model line a decisions grant may admit. */
export interface DecisionsProfileLine {
  /** `publisher/model`, as Kaana's declared catalogue names it. */
  readonly modelLine: string;
  /** The immutable revision Kaana's publisher minted (`observed-…`); a step admits no other. */
  readonly revision: string;
  /** Exact USD ceiling on one request served on this line. */
  readonly maxPricePerRequestUsd: string;
  /** The review this line was admitted on: when, and the evidence it read. */
  readonly review: {
    readonly reviewedAt: string;
    readonly evidenceRefs: readonly string[];
  };
}

/**
 * The decisions profile, in the order its steps are tried.
 *
 * Not listed: OpenAI's `gpt-6-luna` (Decisions API beta, 2026-10-07), which
 * Kaana serves under its own provider slug `openai-decisions`. Its route is
 * built but has no funded key and no zero-data-retention evidence for Oxy's
 * account; it is added here when it has both.
 */
export const DECISIONS_PROFILE: readonly DecisionsProfileLine[] = [
  {
    // TypeSafe's Jev 1.13 through OpenRouter's `/systemone`, provider pinned to
    // TypeSafe with fallbacks off. OpenRouter's public ZDR endpoint list
    // (2026-10-04) carries `TypeSafe | typesafe/jev-1.13-20260917` at
    // USD 0.000000042 per prompt token and 0 per completion token: a request at
    // the 16,000-token decisions ceiling quotes USD 0.000672. Upstream model
    // `typesafe/jev-1.13-20260917`, first published by Kaana on 2026-10-18
    // (`dep_openrouter_typesafe_jev_1_13_20260917_observed_2026_10_18`).
    modelLine: 'typesafe/jev-1.13',
    revision: 'observed-2026-10-18',
    maxPricePerRequestUsd: '0.001',
    review: {
      reviewedAt: '2026-10-18',
      evidenceRefs: [
        'source-evidence:typesafe-privacy.html:sha256:93012e61403f9f7f7536e94914497777f791ab51b017e08bbb5e24bc06cd31c7',
        'source-evidence:zdr-endpoints.json:sha256:cfbf208c4b723c537272d774d2955bb957c35d4d2bfc2c54a383875126aae1b9',
        'kaana:docs/decisions.md#existing-openrouter-route-evidence--2026-10-04',
      ],
    },
  },
];

/** The step limits every decisions step carries, over the application's own policy. */
export const DECISIONS_GRANT_LIMITS = {
  requireZeroDataRetention: true,
  prohibitTrainingOnCustomerData: true,
  sameModelFailover: false,
} as const;
