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
 * published price or immutable identity in place.
 */

export const KAANA_INITIAL_REVIEWED_AT = "2026-09-02T00:00:00.000Z";
export const KAANA_INITIAL_SCORE_VALID_UNTIL = "2026-10-02T00:00:00.000Z";
export const KAANA_INITIAL_MODEL_ID = "openai/gpt-oss-120b";
export const KAANA_INITIAL_MODEL_REFERENCE = `${KAANA_INITIAL_MODEL_ID}@observed-2026-09-01`;
/** Routing-content hash of the exact live inventory reviewed on 2026-09-02. */
export const KAANA_INITIAL_INVENTORY_SNAPSHOT_ID = "snap_7c760c006f5ac633";

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
    | "requests";
  readonly amount: string;
  readonly per: number;
}

export interface KaanaInitialProvider {
  readonly slug: "groq" | "cerebras";
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
  readonly unitPrices: readonly KaanaInitialUnitPrice[];
  readonly scores: {
    readonly price: number;
    /** Neutral across routes until Kaana measures comparable exact-route latency. */
    readonly latency: number;
    readonly throughput: number;
    readonly balanced: number;
  };
}

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
    unitPrices: [
      { unit: "input_tokens", amount: "0.15", per: 1_000_000 },
      { unit: "cached_input_tokens", amount: "0.075", per: 1_000_000 },
      { unit: "output_tokens", amount: "0.60", per: 1_000_000 },
      { unit: "reasoning_tokens", amount: "0.60", per: 1_000_000 },
      { unit: "requests", amount: "0", per: 1 },
    ],
    scores: { price: 1_000, latency: 500, throughput: 600, balanced: 800 },
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

export const KAANA_INITIAL_SCORECARD_REASON =
  "Initial primary-source price/throughput review with neutral unmeasured latency for the exact Kaana deployment identity.";

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
