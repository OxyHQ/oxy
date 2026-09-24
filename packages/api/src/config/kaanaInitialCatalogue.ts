/**
 * Reviewed, deliberately small bootstrap for Kaana's first Oxy-owned catalogue.
 *
 * Kaana's discovery snapshot proves only that an exact deployment exists. Oxy
 * still owns the model identity, commercial scope, customer price and routing
 * scorecard. Keep those facts explicit here: never derive any of them from a
 * provider display name, an upstream alias or database insertion order.
 *
 * Every URL below is a primary source reviewed on 2026-09-02. The bootstrap
 * command refuses existing rows whose values differ and never updates a
 * published price or immutable identity in place. The one exception is a
 * same-value scorecard validity renewal (`scoreRenewal`), applied only by
 * `scripts/renew-kaana-routing-scores.ts` and only over the exact superseded row.
 */

export const KAANA_INITIAL_REVIEWED_AT = "2026-09-02T00:00:00.000Z";
/**
 * Current expiry of every reviewed scorecard below. Runtime refuses the WHOLE
 * route set once any selectable route's balanced score is stale, so this date
 * is a production cliff: renew it through
 * `.github/workflows/renew-kaana-routing-scores.yml` well before it passes.
 */
export const KAANA_INITIAL_SCORE_VALID_UNTIL = "2026-11-01T00:00:00.000Z";
/** The expiry the first bootstrap wrote for Cerebras and Groq. */
export const KAANA_INITIAL_FIRST_SCORE_VALID_UNTIL = "2026-10-02T00:00:00.000Z";

/**
 * One owner-approved, same-value validity renewal of the reviewed scorecards.
 *
 * Scores, sources, evidence references and measurement windows are NOT
 * re-reviewed here; only the validity horizon moves. The renewal is itself an
 * audited write: the current row is updated and one new append-only event is
 * recorded at exactly `reviewedAt`.
 */
export const KAANA_SCORE_RENEWAL_2026_09_24 = {
  reviewedAt: "2026-09-24T00:00:00.000Z",
  validUntil: KAANA_INITIAL_SCORE_VALID_UNTIL,
  reason:
    "Owner-approved same-value validity renewal on 2026-09-24: scores, sources, evidence and measurement windows unchanged; validity extended to 2026-11-01.",
} as const;
export const KAANA_INITIAL_MODEL_ID = "openai/gpt-oss-120b";
export const KAANA_INITIAL_MODEL_REFERENCE = `${KAANA_INITIAL_MODEL_ID}@observed-2026-09-01`;
/**
 * Routing-content hash of the exact live inventory the bootstrap accepts.
 *
 * Re-pinned on 2026-09-24 to the schema-0013 cutover snapshot (334
 * deployments). It still carries the three reviewed gpt-oss deployments with
 * byte-identical identity facts, and adds the reviewed xAI speech deployment.
 */
export const KAANA_INITIAL_INVENTORY_SNAPSHOT_ID = "snap_37548e4f1f8ec610";

export const KAANA_INITIAL_PUBLISHER = {
  slug: "openai",
  displayName: "OpenAI",
  websiteUrl: "https://openai.com/",
} as const;

export const KAANA_INITIAL_MODEL = {
  publisherSlug: KAANA_INITIAL_PUBLISHER.slug,
  slug: "gpt-oss-120b",
  displayName: "GPT-OSS 120B",
  description:
    "Open-weight text reasoning model for agentic and tool-using workloads.",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsTools: true,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: true,
  supportsJsonMode: true,
  supportsReasoning: true,
  supportsStreaming: true,
  supportsPromptCaching: true,
  maxContextTokens: 131_072,
  // Conservative common route ceiling: Cerebras publishes 40,960 while Groq
  // publishes 65,536. A catalogue capability must work on every listed route.
  maxOutputTokens: 40_960,
  licenseId: "Apache-2.0",
  licenseDisplayName: "Apache License 2.0",
  licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
  commercialUseAllowed: true,
  requiresAttribution: false,
  baseModelAttributionRequired: false,
  acceptableUsePolicyUrl: "https://openai.com/policies/usage-policies/",
  releaseKind: "open_weight",
  trainingOrganization: "OpenAI",
  knowledgeCutoff: "2024-06-01",
  releasedOn: "2025-08-05",
  deprecationStatus: "active",
} as const;

export const KAANA_INITIAL_REVISION = {
  revision: "observed-2026-09-01",
  isCurrent: true,
  releasedAt: "2025-08-05T00:00:00.000Z",
  modelCardUrl: "https://openai.com/index/gpt-oss-model-card/",
} as const;

export interface KaanaInitialUnitPrice {
  readonly unit:
    | "input_tokens"
    | "cached_input_tokens"
    | "output_tokens"
    | "reasoning_tokens"
    | "characters"
    | "requests";
  readonly amount: string;
  readonly per: number;
}

export interface KaanaScorecardReview {
  /** Exact `changedAt` of the row, and `createdAt` of its provenance event. */
  readonly changedAt: string;
  /** Exact latency, throughput and balanced `validUntil`. */
  readonly validUntil: string;
  readonly reason: string;
}

export interface KaanaScoreRenewal {
  readonly reviewedAt: string;
  readonly reason: string;
  readonly supersedes: KaanaScorecardReview;
}

export interface KaanaInitialProvider {
  readonly slug: "groq" | "cerebras" | "openrouter" | "xai";
  readonly displayName: string;
  readonly websiteUrl: string;
  readonly statusPageUrl?: string;
  readonly retainsPayloads: boolean;
  readonly retentionDays: number;
  readonly trainsOnCustomerData: boolean;
  readonly zeroDataRetentionAvailable: boolean;
  readonly policyUrl: string;
  readonly deploymentId: string;
  readonly upstreamModelId: string;
  readonly legalEvidenceRef: string;
  readonly priceEvidenceRef: string;
  readonly performanceEvidenceRef: string;
  readonly reviewedAt?: string;
  readonly scoreValidUntil?: string;
  readonly priceEffectiveFrom?: string;
  readonly scorecardReason?: string;
  readonly permissionStateNote?: string;
  /**
   * The latest same-value validity renewal. When present, the current scorecard
   * row carries `scoreRenewal.reviewedAt` as `changedAt` and
   * `scoreRenewal.reason`, and `supersedes` is the exact prior state the renewal
   * workflow is allowed to replace. Any other prior state is drift and refused.
   */
  readonly scoreRenewal?: KaanaScoreRenewal;
  readonly unitPrices: readonly KaanaInitialUnitPrice[];
  readonly scores: {
    readonly price: number;
    /** Neutral across routes until Kaana measures comparable exact-route latency. */
    readonly latency: number;
    readonly throughput: number;
    readonly balanced: number;
  };
}

export const KAANA_INITIAL_SCORECARD_REASON =
  "Initial primary-source price/throughput review with neutral unmeasured latency for the exact Kaana deployment identity.";

const KAANA_OPENROUTER_SCORECARD_REASON =
  "Primary-source OpenRouter price review with neutral unmeasured exact-route latency and throughput; recovery ordering uses no provider performance claim.";

/** Reviewed scorecard policy shared by every initial route. */
export const KAANA_INITIAL_SCORE_POLICY = {
  latencyEvidenceRef: "not-measured:exact-deployment-bootstrap-2026-09-02",
  fundingClass: "standard_payg",
  fundingState: "available",
  fundingEvidenceSource: "provider.priceEvidenceRef",
} as const;

export const KAANA_INITIAL_PROVIDERS: readonly KaanaInitialProvider[] = [
  {
    slug: "cerebras",
    displayName: "Cerebras",
    websiteUrl: "https://www.cerebras.ai/",
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    policyUrl: "https://cloud.cerebras.ai/privacy",
    deploymentId: "dep_cerebras_gpt_oss_120b_observed_2026_09_01",
    upstreamModelId: "gpt-oss-120b",
    legalEvidenceRef:
      "owner-review-2026-09-02:https://cloud.cerebras.ai/terms;https://openai.com/index/gpt-oss-model-card/",
    priceEvidenceRef: "https://api.cerebras.ai/public/v1/models",
    performanceEvidenceRef:
      "https://inference-docs.cerebras.ai/models/overview",
    scoreRenewal: {
      reviewedAt: KAANA_SCORE_RENEWAL_2026_09_24.reviewedAt,
      reason: KAANA_SCORE_RENEWAL_2026_09_24.reason,
      supersedes: {
        changedAt: KAANA_INITIAL_REVIEWED_AT,
        validUntil: KAANA_INITIAL_FIRST_SCORE_VALID_UNTIL,
        reason: KAANA_INITIAL_SCORECARD_REASON,
      },
    },
    unitPrices: [
      { unit: "input_tokens", amount: "0.35", per: 1_000_000 },
      { unit: "cached_input_tokens", amount: "0.35", per: 1_000_000 },
      { unit: "output_tokens", amount: "0.75", per: 1_000_000 },
      { unit: "reasoning_tokens", amount: "0.75", per: 1_000_000 },
      { unit: "requests", amount: "0", per: 1 },
    ],
    // The provider publishes throughput, not a comparable end-to-end latency
    // measurement. The SAME reviewed neutral value on every route cannot create
    // a latency preference. Balanced excludes it until Kaana measures latency.
    scores: { price: 600, latency: 500, throughput: 1_000, balanced: 800 },
  },
  {
    slug: "groq",
    displayName: "Groq",
    websiteUrl: "https://groq.com/",
    statusPageUrl: "https://groqstatus.com/",
    // Groq documents no default inference retention, but allows temporary
    // reliability/abuse logs for up to 30 days unless ZDR is enabled.
    retainsPayloads: true,
    retentionDays: 30,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    policyUrl: "https://console.groq.com/docs/your-data",
    deploymentId: "dep_groq_openai_gpt_oss_120b_observed_2026_09_01",
    upstreamModelId: "openai/gpt-oss-120b",
    legalEvidenceRef:
      "owner-review-2026-09-02:https://console.groq.com/docs/legal/services-agreement;https://openai.com/index/gpt-oss-model-card/",
    priceEvidenceRef: "https://console.groq.com/docs/model/openai/gpt-oss-120b",
    performanceEvidenceRef:
      "https://console.groq.com/docs/model/openai/gpt-oss-120b",
    scoreRenewal: {
      reviewedAt: KAANA_SCORE_RENEWAL_2026_09_24.reviewedAt,
      reason: KAANA_SCORE_RENEWAL_2026_09_24.reason,
      supersedes: {
        changedAt: KAANA_INITIAL_REVIEWED_AT,
        validUntil: KAANA_INITIAL_FIRST_SCORE_VALID_UNTIL,
        reason: KAANA_INITIAL_SCORECARD_REASON,
      },
    },
    unitPrices: [
      { unit: "input_tokens", amount: "0.15", per: 1_000_000 },
      { unit: "cached_input_tokens", amount: "0.075", per: 1_000_000 },
      { unit: "output_tokens", amount: "0.60", per: 1_000_000 },
      { unit: "reasoning_tokens", amount: "0.60", per: 1_000_000 },
      { unit: "requests", amount: "0", per: 1 },
    ],
    scores: { price: 1_000, latency: 500, throughput: 600, balanced: 800 },
  },
  {
    slug: "openrouter",
    displayName: "OpenRouter",
    websiteUrl: "https://openrouter.ai/",
    statusPageUrl: "https://status.openrouter.ai/",
    // Kaana binds every OpenRouter request to `zdr: true` and
    // `data_collection: deny`; those controls can only narrow the account
    // policy and OpenRouter refuses the request when no compliant endpoint is
    // available. This metadata describes that exact adapter-enforced route,
    // not OpenRouter's unconstrained default router.
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    policyUrl: "https://openrouter.ai/docs/guides/privacy/provider-logging",
    deploymentId:
      "dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01",
    upstreamModelId: "openai/gpt-oss-120b",
    legalEvidenceRef:
      "owner-review-2026-09-11:https://openrouter.ai/terms;https://openai.com/index/gpt-oss-model-card/;scope=internal-alia-standard-application-use-not-api-resale",
    priceEvidenceRef: "https://openrouter.ai/openai/gpt-oss-120b",
    performanceEvidenceRef:
      "not-measured:openrouter-exact-deployment-2026-09-11",
    reviewedAt: "2026-09-11T00:00:00.000Z",
    scoreValidUntil: KAANA_SCORE_RENEWAL_2026_09_24.validUntil,
    priceEffectiveFrom: "2026-09-11T00:00:00.000Z",
    scorecardReason: KAANA_OPENROUTER_SCORECARD_REASON,
    scoreRenewal: {
      reviewedAt: KAANA_SCORE_RENEWAL_2026_09_24.reviewedAt,
      reason: KAANA_SCORE_RENEWAL_2026_09_24.reason,
      supersedes: {
        changedAt: "2026-09-11T00:00:00.000Z",
        validUntil: "2026-10-11T00:00:00.000Z",
        reason: KAANA_OPENROUTER_SCORECARD_REASON,
      },
    },
    permissionStateNote:
      "Owner-approved internal Alia route; primary-source review 2026-09-11; not approved for API resale.",
    unitPrices: [
      { unit: "input_tokens", amount: "0.03", per: 1_000_000 },
      { unit: "cached_input_tokens", amount: "0.03", per: 1_000_000 },
      { unit: "output_tokens", amount: "0.17", per: 1_000_000 },
      { unit: "reasoning_tokens", amount: "0.17", per: 1_000_000 },
      { unit: "requests", amount: "0", per: 1 },
    ],
    scores: { price: 1_000, latency: 500, throughput: 500, balanced: 750 },
  },
] as const;

/**
 * Permanent database primary keys reserved by this reviewed bootstrap.
 *
 * These are the runtime authorities passed through `routingProfileId`. Slugs
 * remain human-facing catalogue labels and collision checks only; neither a
 * deploy workflow nor a product may discover one of these rows by slug, name,
 * or insertion order.
 */
export const KAANA_INITIAL_ROUTING_PROFILE_IDS = {
  lite: "01a06477-94f5-74f0-bc25-4a1ff59d6945",
  default: "01a06477-94f5-74f0-bc25-4c5c13b93ccd",
  code: "01a06477-94f5-74f0-bc25-52437e0c724d",
  cowork: "01a06477-94f5-74f0-bc25-55ea2ebdb2b6",
  browser: "01a06477-94f5-74f0-bc25-5a78baecbef6",
  pro: "01a06477-94f5-74f0-bc25-5d796b49b616",
  thinking: "01a06477-94f5-74f0-bc25-628b5f45d802",
  proMax: "01a06477-94f5-74f0-bc25-658eeb277737",
} as const;

/** Text profiles Alia currently needs. Unsupported modality profiles stay absent. */
export const KAANA_INITIAL_ROUTING_PROFILES = [
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.lite,
    slug: "kaana-lite",
    displayName: "Kaana Lite",
    optimiseFor: "price",
  },
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.default,
    slug: "kaana-v1",
    displayName: "Kaana",
    optimiseFor: "balanced",
  },
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.code,
    slug: "kaana-v1-codea",
    displayName: "Kaana Code",
    optimiseFor: "balanced",
  },
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.cowork,
    slug: "kaana-v1-cowork",
    displayName: "Kaana Cowork",
    optimiseFor: "balanced",
  },
  // There is no comparable exact-deployment latency measurement yet, so the
  // browser preset uses the reviewed balanced dimension rather than inventing
  // a latency ordering from provider marketing or a display name.
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.browser,
    slug: "kaana-v1-browser",
    displayName: "Kaana Browser",
    optimiseFor: "balanced",
  },
  // Runtime has no quality score dimension yet. Product presentation does not
  // get to invent one: these profiles use the supported balanced scorecard.
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.pro,
    slug: "kaana-v1-pro",
    displayName: "Kaana Pro",
    optimiseFor: "balanced",
  },
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.thinking,
    slug: "kaana-v1-thinking",
    displayName: "Kaana Thinking",
    optimiseFor: "balanced",
  },
  {
    id: KAANA_INITIAL_ROUTING_PROFILE_IDS.proMax,
    slug: "kaana-v1-pro-max",
    displayName: "Kaana Pro Max",
    optimiseFor: "balanced",
  },
] as const;

export const KAANA_INITIAL_BALANCED_FORMULA_REF =
  "reviewed-scorecard-v1:round((price+throughput)/2);latency-unmeasured";


/** Measurement windows stay at the original review; renewals never move them. */
export function kaanaScoreMeasuredAt(provider: KaanaInitialProvider): string {
  return provider.reviewedAt ?? KAANA_INITIAL_REVIEWED_AT;
}

/** The scorecard state the database must hold for this provider now. */
export function kaanaCurrentScorecardReview(
  provider: KaanaInitialProvider,
): KaanaScorecardReview {
  return {
    changedAt: provider.scoreRenewal?.reviewedAt ?? kaanaScoreMeasuredAt(provider),
    validUntil: provider.scoreValidUntil ?? KAANA_INITIAL_SCORE_VALID_UNTIL,
    reason:
      provider.scoreRenewal?.reason ??
      provider.scorecardReason ??
      KAANA_INITIAL_SCORECARD_REASON,
  };
}

export function requireSingleKaanaBootstrapScoreEvent<T>(
  deploymentId: string,
  events: readonly T[],
): T {
  if (events.length !== 1) {
    throw new Error(
      `Scorecard ${deploymentId} must have exactly one append-only provenance event; found ${events.length}`,
    );
  }
  const event = events.at(0);
  if (event === undefined) {
    throw new Error(`Scorecard ${deploymentId} provenance event is absent`);
  }
  return event;
}

/* -------------------------------------------------------------------------- */
/*  Speech: Alia's text-to-speech route                                       */
/* -------------------------------------------------------------------------- */

/**
 * Primary-source review of the one xAI speech deployment Kaana serves.
 *
 * xAI's speech endpoint has no model selector: Kaana discovers it through the
 * authenticated voice catalogue and names it `tts`, attributed to
 * `x-ai/text-to-speech` with first-observation revision semantics. The
 * revision is therefore Kaana's observed identity, not a claim about weights.
 */
export const KAANA_SPEECH_REVIEWED_AT = "2026-09-24T00:00:00.000Z";
export const KAANA_SPEECH_MODEL_ID = "x-ai/text-to-speech";
export const KAANA_SPEECH_MODEL_REFERENCE = `${KAANA_SPEECH_MODEL_ID}@observed-2026-09-24`;

/**
 * Kaana's xAI speech translation refuses input above 15,000 UTF-16 units
 * (`internal/provider/openaicompat/speech.go`), stricter than xAI's own unary
 * limit. The edge's capacity gate compares the model's context ceiling with
 * `estimateInputTokens`, which for a speech request is the input length plus
 * one 8-unit message overhead. 15,008 therefore admits exactly the inputs
 * Kaana can serve and refuses the rest before a hold is reserved.
 */
export const KAANA_SPEECH_MAX_INPUT_CHARACTERS = 15_000;

export const KAANA_SPEECH_PUBLISHER = {
  slug: "x-ai",
  displayName: "xAI",
  websiteUrl: "https://x.ai/",
} as const;

export const KAANA_SPEECH_MODEL = {
  publisherSlug: KAANA_SPEECH_PUBLISHER.slug,
  slug: "text-to-speech",
  displayName: "Text to Speech",
  description: "Hosted text-to-speech endpoint that returns spoken audio.",
  inputModalities: ["text"],
  outputModalities: ["audio"],
  supportsTools: false,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: false,
  supportsJsonMode: false,
  supportsReasoning: false,
  // The edge answers speech with one complete audio body; Kaana refuses a
  // streaming speech request.
  supportsStreaming: false,
  supportsPromptCaching: false,
  maxContextTokens: KAANA_SPEECH_MAX_INPUT_CHARACTERS + 8,
  // Speech generates no tokens and the edge's output budget for it is zero.
  // The column requires a positive value; 1 is the smallest one and is never
  // used to size a hold for speech.
  maxOutputTokens: 1,
  licenseId: "xAI-Enterprise-Terms",
  licenseDisplayName: "xAI Enterprise Terms of Service",
  licenseUrl: "https://x.ai/legal/terms-of-service-enterprise",
  commercialUseAllowed: true,
  requiresAttribution: false,
  baseModelAttributionRequired: false,
  acceptableUsePolicyUrl: null,
  releaseKind: "third_party_hosted",
  trainingOrganization: "xAI",
  knowledgeCutoff: null,
  releasedOn: null,
  deprecationStatus: "active",
} as const;

export const KAANA_SPEECH_REVISION = {
  revision: "observed-2026-09-24",
  isCurrent: true,
  // xAI publishes no release instant for the endpoint; this is the Kaana
  // observation that names the revision.
  releasedAt: KAANA_SPEECH_REVIEWED_AT,
  modelCardUrl:
    "https://docs.x.ai/developers/model-capabilities/audio/text-to-speech",
  // A non-text model must declare its content provenance (migration 0050's
  // trigger refuses the revision otherwise). xAI's speech documentation
  // publishes no watermark or C2PA marking, and Kaana stamps none: `none` is
  // that declaration. Moderation is xAI's own default under its usage policy.
  contentFilteringDefault: "provider_default",
  provenanceMarking: "none",
} as const;

const KAANA_SPEECH_SCORECARD_REASON =
  "Primary-source xAI list-price review of the single exact speech route with neutral unmeasured latency and throughput; the speech profile ranks on price and makes no provider performance claim.";

export const KAANA_SPEECH_PROVIDERS: readonly KaanaInitialProvider[] = [
  {
    slug: "xai",
    displayName: "xAI",
    websiteUrl: "https://x.ai/",
    // xAI stores API requests and responses for 30 days for abuse auditing,
    // never trains on them, and offers team-wide ZDR. The default is recorded:
    // ZDR is not asserted for Oxy's xAI team.
    retainsPayloads: true,
    retentionDays: 30,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    policyUrl: "https://docs.x.ai/developers/faq/security",
    deploymentId: "dep_xai_tts_observed_2026_09_24",
    upstreamModelId: "tts",
    legalEvidenceRef:
      "owner-approval-2026-09-24:https://x.ai/legal/terms-of-service-enterprise;https://docs.x.ai/developers/faq/security;scope=internal-alia-standard-application-use-not-api-resale",
    // Customer price is the provider list price with no markup, as for every
    // reviewed route: $15.00 per 1M characters, and an explicit free request.
    priceEvidenceRef: "https://docs.x.ai/developers/pricing",
    performanceEvidenceRef: "not-measured:xai-tts-exact-deployment-2026-09-24",
    reviewedAt: KAANA_SPEECH_REVIEWED_AT,
    scoreValidUntil: KAANA_INITIAL_SCORE_VALID_UNTIL,
    priceEffectiveFrom: KAANA_SPEECH_REVIEWED_AT,
    scorecardReason: KAANA_SPEECH_SCORECARD_REASON,
    permissionStateNote:
      "Owner-approved internal Alia speech route; primary-source review 2026-09-24; not approved for API resale.",
    unitPrices: [
      { unit: "characters", amount: "15.00", per: 1_000_000 },
      { unit: "requests", amount: "0", per: 1 },
    ],
    // One route: the price rank cannot reorder anything. Neutral 500s mirror
    // the unmeasured OpenRouter route; balanced follows the shared formula.
    scores: { price: 1_000, latency: 500, throughput: 500, balanced: 750 },
  },
] as const;

/**
 * The speech-only profile Alia reserved before this catalogue existed.
 *
 * Alia pins this exact ID (`OXY_KAANA_SPEECH_ROUTING_PROFILE_ID`), so it is
 * adopted verbatim rather than generated: it is a v4 UUID, unlike the text
 * profile keys. It is never a stored agent or chat profile.
 */
export const KAANA_SPEECH_ROUTING_PROFILE_ID =
  "cc2471c8-807e-46ec-b5da-b6f3b39d2db5";

export const KAANA_SPEECH_ROUTING_PROFILES = [
  {
    id: KAANA_SPEECH_ROUTING_PROFILE_ID,
    slug: "kaana-v1-speech",
    displayName: "Kaana Speech",
    optimiseFor: "price",
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Every reviewed model the bootstrap owns                                   */
/* -------------------------------------------------------------------------- */

export interface KaanaReviewedModelCatalogue {
  readonly publisher: {
    readonly slug: string;
    readonly displayName: string;
    readonly websiteUrl: string;
  };
  readonly model: typeof KAANA_INITIAL_MODEL | typeof KAANA_SPEECH_MODEL;
  readonly modelId: string;
  readonly modelReference: string;
  readonly revision: typeof KAANA_INITIAL_REVISION | typeof KAANA_SPEECH_REVISION;
  readonly providers: readonly KaanaInitialProvider[];
  readonly routingProfiles: readonly {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly optimiseFor: "price" | "balanced";
  }[];
}

export const KAANA_TEXT_CATALOGUE: KaanaReviewedModelCatalogue = {
  publisher: KAANA_INITIAL_PUBLISHER,
  model: KAANA_INITIAL_MODEL,
  modelId: KAANA_INITIAL_MODEL_ID,
  modelReference: KAANA_INITIAL_MODEL_REFERENCE,
  revision: KAANA_INITIAL_REVISION,
  providers: KAANA_INITIAL_PROVIDERS,
  routingProfiles: KAANA_INITIAL_ROUTING_PROFILES,
};

export const KAANA_SPEECH_CATALOGUE: KaanaReviewedModelCatalogue = {
  publisher: KAANA_SPEECH_PUBLISHER,
  model: KAANA_SPEECH_MODEL,
  modelId: KAANA_SPEECH_MODEL_ID,
  modelReference: KAANA_SPEECH_MODEL_REFERENCE,
  revision: KAANA_SPEECH_REVISION,
  providers: KAANA_SPEECH_PROVIDERS,
  routingProfiles: KAANA_SPEECH_ROUTING_PROFILES,
};

/** Bootstrap order: text first, exactly as before speech existed. */
export const KAANA_REVIEWED_CATALOGUES = [
  KAANA_TEXT_CATALOGUE,
  KAANA_SPEECH_CATALOGUE,
] as const;

/** Every reviewed route, for the inventory gate and the score renewal. */
export const KAANA_REVIEWED_PROVIDERS: readonly KaanaInitialProvider[] =
  KAANA_REVIEWED_CATALOGUES.flatMap((catalogue) => catalogue.providers);

/** The reviewed profile candidate policy: one pinned revision, priority 100. */
export const KAANA_REVIEWED_CANDIDATE_PRIORITY = 100;

/** The identities one model contributes to the bootstrap result and plan. */
export interface KaanaReviewedCatalogueProjection {
  readonly publisher: string;
  readonly model: string;
  readonly revision: string;
  readonly candidate: { readonly modelReference: string; readonly priority: number };
  readonly providers: string[];
  readonly deployments: string[];
  readonly routingProfileIds: string[];
}

export function kaanaReviewedCatalogueProjection(
  catalogue: KaanaReviewedModelCatalogue,
): KaanaReviewedCatalogueProjection {
  return {
    publisher: catalogue.publisher.slug,
    model: catalogue.modelId,
    revision: catalogue.modelReference,
    candidate: {
      modelReference: catalogue.modelReference,
      priority: KAANA_REVIEWED_CANDIDATE_PRIORITY,
    },
    providers: catalogue.providers.map((provider) => provider.slug),
    deployments: catalogue.providers.map((provider) => provider.deploymentId),
    routingProfileIds: catalogue.routingProfiles.map((profile) => profile.id),
  };
}

/**
 * Every insert a first bootstrap of `catalogue` may perform, in write order.
 * The workflow allow-lists exactly these operation names.
 */
export function kaanaReviewedCatalogueOperations(
  catalogue: KaanaReviewedModelCatalogue,
): string[] {
  return [
    `publisher:${catalogue.publisher.slug}`,
    `model:${catalogue.modelId}`,
    `revision:${catalogue.modelReference}`,
    ...catalogue.providers.flatMap((provider) => [
      `provider:${provider.slug}`,
      `price:${catalogue.modelReference}:${provider.slug}`,
      `deployment:${provider.deploymentId}`,
      `scorecard:${provider.deploymentId}`,
    ]),
    ...catalogue.routingProfiles.flatMap((profile) => [
      `profile:${profile.slug}`,
      `profile-candidate:${profile.slug}:${catalogue.modelReference}`,
    ]),
  ];
}
