/**
 * Reviewed facts for Kaana deployments whose provider's authenticated model
 * list does not publish them.
 *
 * ADR 0027 prices every synced route from "the provider's list price" and
 * keeps its accepted request controls from Kaana's per-deployment descriptor.
 * Kaana reads both from the provider's own model list (`observed.listPrice`,
 * `observed.acceptedParameters`). Anthropic's Models API publishes neither, so
 * Kaana left both absent for its direct `anthropic` deployments
 * (OxyHQ/Kaana#166; Kaana `docs/provider-onboarding.md`, "Anthropic"). Since
 * OxyHQ/Kaana#168 Kaana publishes its Messages adapter's own per-model accepted
 * controls; the price is still absent. Anthropic DOES publish both facts, in
 * its pricing and model documentation. This file is the reviewed reading of
 * those pages, consumed by the catalogue sync and by nothing else; its
 * accepted controls are intersected with Kaana's, so they must agree.
 *
 * ## Why Oxy, and why this is not a second price system
 *
 * The customer price is Oxy's (ADR 0006; Kaana "measures units and never prices
 * them"). Kaana's rate cards are a different number — what the upstream
 * invoices Kaana — they are keyed by a deployment id that only exists once the
 * publisher has observed it, and no operator read exposes them as a price. What
 * this file supplies is the same fact a Kaana `listPrices` row would carry, for
 * a provider that publishes it on a web page instead of in its model list. The
 * sync writes it into the same `price_versions` and scorecards, with the same
 * supersede-on-change rule, and a Kaana-published list price for a deployment
 * always wins over this one.
 *
 * ## The key: exact provider and exact Kaana model line
 *
 * Kaana deliberately keeps the upstream model id out of ordinary deployment
 * descriptors (it is an adapter detail, not part of the identity Oxy signs), and
 * a direct deployment's id embeds the date Kaana first observed it. What Oxy
 * can match exactly is `(provider, model line)`: Kaana's reviewed Anthropic
 * attribution maps each Anthropic model id to exactly one line, and refuses a
 * second id for the same line, so the pair names one upstream model.
 * `upstreamModelId` records which one, for review; it is never matched against
 * anything. A line Kaana re-attributes to another upstream id must be reviewed
 * here again. A price is NEVER inherited from another provider's route of the
 * same line (OpenRouter publishes its own, separately).
 *
 * ## Accepted request controls
 *
 * `acceptedParameters` uses Kaana's closed vocabulary (OxyHQ/Kaana#124) and the
 * edge's rule: a route whose known set lacks a control the request carries is
 * never signed, so a request with, say, `sampling.temperature` for Claude
 * Sonnet 5.5 is served by another deployment of the line instead of failing on
 * Anthropic's 400 (Kaana treats an upstream `invalid_request` and its own
 * Translate refusal as terminal: neither fails over). The sync intersects this
 * statement with any set Kaana itself publishes for the deployment.
 *
 * A tool choice is stated per value (`toolChoice.none`, `.required`,
 * `.function`; OxyHQ/Kaana#168), and `auto` needs no value. Anthropic refuses
 * only a FORCING `tool_choice` (`any`/`tool`) on Fable 5.1, Opus 5.5 and Sonnet
 * 5.5, so those routes take `none` and every `auto` tool request, and only a
 * forced choice is served by another deployment of the line. Sampling stays
 * presence-only: Anthropic refuses a non-default `temperature`/`top_p`, the
 * edge cannot tell a default value apart, so those deployments state the whole
 * control as not accepted.
 */

import type { DeploymentRequestParameter } from '../db/schema';

/** USD per million tokens, exact decimals. */
export interface ReviewedTokenPrice {
  readonly input: string;
  /** A prompt-cache read (Kaana's `cached_input_tokens`). */
  readonly cachedInput: string;
  readonly output: string;
}

export interface ReviewedProviderRoute {
  /** Kaana's provider slug, exactly. */
  readonly provider: string;
  /** Kaana's model line (`publisher/model`), exactly. */
  readonly model: string;
  /** The upstream model this line is attributed to by Kaana. Documentation only. */
  readonly upstreamModelId: string;
  readonly price: ReviewedTokenPrice;
  /** Where the price was read, and when. At most 500 characters (scorecard column). */
  readonly priceEvidenceRef: string;
  /** Kaana vocabulary, in vocabulary order. */
  readonly acceptedParameters: readonly DeploymentRequestParameter[];
}

/** The day every Anthropic fact below was read from Anthropic's own documentation. */
export const ANTHROPIC_REVIEWED_AT = '2026-10-11';

const ANTHROPIC_PRICE_EVIDENCE = `https://platform.claude.com/docs/en/about-claude/pricing@${ANTHROPIC_REVIEWED_AT}`;

/**
 * What Kaana's Messages adapter sends. It refuses `responseFormat` (non-text),
 * `sampling.frequencyPenalty`, `sampling.presencePenalty` and `sampling.seed` in
 * Translate (Kaana `docs/provider-onboarding.md`, "Anthropic"), so those are
 * absent from every Anthropic route.
 */
const ANTHROPIC_MESSAGES_CONTROLS: readonly DeploymentRequestParameter[] = [
  'maxOutputTokens',
  'reasoning.effort',
  'sampling.stopSequences',
  'sampling.temperature',
  'sampling.topP',
  'toolChoice',
  'toolChoice.function',
  'toolChoice.none',
  'toolChoice.required',
  'tools',
];

function without(
  controls: readonly DeploymentRequestParameter[],
  refused: readonly DeploymentRequestParameter[],
): readonly DeploymentRequestParameter[] {
  return controls.filter((control) => !refused.includes(control));
}

/**
 * Claude Opus 4.7 and every later model answer a non-default `temperature`,
 * `top_p` or `top_k` with a 400 (platform.claude.com/docs/en/models/opus-5-5/migration-guide:
 * "Setting temperature, top_p, or top_k to any non-default value on Claude Opus
 * 4.7 and later models ... returns a 400 error"; the Sonnet 5, Sonnet 5.5,
 * Haiku 5.5 and Fable 5.1 pages say the same of those models).
 */
const ANTHROPIC_FIXED_SAMPLING = without(ANTHROPIC_MESSAGES_CONTROLS, [
  'sampling.temperature',
  'sampling.topP',
]);

/**
 * Fable 5.1, Opus 5.5 and Sonnet 5.5 also reject `tool_choice` `any`/`tool`
 * with a 400 ("tool_choice: type \"tool\" and \"any\" are not supported for
 * this model"; their migration guides) and take `auto` (the default) and
 * `none`.
 */
const ANTHROPIC_FIXED_SAMPLING_NO_FORCED_TOOL = without(ANTHROPIC_FIXED_SAMPLING, [
  'toolChoice.function',
  'toolChoice.required',
]);

function anthropic(
  model: string,
  upstreamModelId: string,
  price: ReviewedTokenPrice,
  acceptedParameters: readonly DeploymentRequestParameter[],
): ReviewedProviderRoute {
  return {
    provider: 'anthropic',
    model,
    upstreamModelId,
    price,
    priceEvidenceRef: ANTHROPIC_PRICE_EVIDENCE,
    acceptedParameters,
  };
}

/**
 * Anthropic's list prices, read 2026-10-11 at
 * https://platform.claude.com/docs/en/about-claude/pricing ("Model pricing":
 * base input, cache hits and refreshes, output; USD per MTok). Kaana sends no
 * `inference_geo`, so the global price applies, and no `cache_control`, so no
 * cache write is billed (Kaana folds any into `input_tokens`). Reasoning tokens
 * are output tokens on Anthropic's invoice and are charged at the output rate.
 *
 * Claude Haiku 5.5 is priced by prompt length ($0.10/$0.50 up to 100,000 prompt
 * tokens, $0.50/$2.50 above, cache read $0.01/$0.05). A price version states one
 * rate per unit, so the route carries the higher tier: Oxy never charges less
 * than Anthropic invoices for a long prompt.
 *
 * The line mapping is Kaana's reviewed Anthropic attribution
 * (`docs/provider-onboarding.md`, "Anthropic", OxyHQ/Kaana#166).
 */
export const KAANA_REVIEWED_PROVIDER_ROUTES: readonly ReviewedProviderRoute[] = [
  anthropic(
    'anthropic/claude-fable-5.1',
    'claude-fable-5-1',
    { input: '10', cachedInput: '0.25', output: '50' },
    ANTHROPIC_FIXED_SAMPLING_NO_FORCED_TOOL,
  ),
  anthropic(
    'anthropic/claude-fable-5',
    'claude-fable-5',
    { input: '10', cachedInput: '1', output: '50' },
    ANTHROPIC_FIXED_SAMPLING,
  ),
  anthropic(
    'anthropic/claude-opus-5.5',
    'claude-opus-5-5',
    { input: '4', cachedInput: '0.2', output: '20' },
    ANTHROPIC_FIXED_SAMPLING_NO_FORCED_TOOL,
  ),
  anthropic(
    'anthropic/claude-opus-5',
    'claude-opus-5',
    { input: '5', cachedInput: '0.5', output: '25' },
    ANTHROPIC_FIXED_SAMPLING,
  ),
  anthropic(
    'anthropic/claude-opus-4.8',
    'claude-opus-4-8',
    { input: '5', cachedInput: '0.5', output: '25' },
    ANTHROPIC_FIXED_SAMPLING,
  ),
  anthropic(
    'anthropic/claude-opus-4.7',
    'claude-opus-4-7',
    { input: '5', cachedInput: '0.5', output: '25' },
    ANTHROPIC_FIXED_SAMPLING,
  ),
  anthropic(
    'anthropic/claude-opus-4.6',
    'claude-opus-4-6',
    { input: '5', cachedInput: '0.5', output: '25' },
    ANTHROPIC_MESSAGES_CONTROLS,
  ),
  anthropic(
    'anthropic/claude-opus-4.5',
    'claude-opus-4-5-20251101',
    { input: '5', cachedInput: '0.5', output: '25' },
    ANTHROPIC_MESSAGES_CONTROLS,
  ),
  anthropic(
    'anthropic/claude-sonnet-5.5',
    'claude-sonnet-5-5',
    { input: '2', cachedInput: '0.1', output: '10' },
    ANTHROPIC_FIXED_SAMPLING_NO_FORCED_TOOL,
  ),
  anthropic(
    'anthropic/claude-sonnet-5',
    'claude-sonnet-5',
    { input: '2', cachedInput: '0.2', output: '10' },
    ANTHROPIC_FIXED_SAMPLING,
  ),
  anthropic(
    'anthropic/claude-sonnet-4.6',
    'claude-sonnet-4-6',
    { input: '3', cachedInput: '0.3', output: '15' },
    ANTHROPIC_MESSAGES_CONTROLS,
  ),
  anthropic(
    'anthropic/claude-haiku-5.5',
    'claude-haiku-5-5',
    { input: '0.5', cachedInput: '0.05', output: '2.5' },
    ANTHROPIC_FIXED_SAMPLING,
  ),
  // Claude Haiku 4.5 takes no effort control: Anthropic's Models API marks
  // `capabilities.effort` unsupported (Kaana publishes `reasoningEfforts: []`).
  anthropic(
    'anthropic/claude-haiku-4.5',
    'claude-haiku-4-5-20251001',
    { input: '1', cachedInput: '0.1', output: '5' },
    without(ANTHROPIC_MESSAGES_CONTROLS, ['reasoning.effort']),
  ),
];

/** `provider\u0000model` → its reviewed facts. */
export type ReviewedProviderRouteIndex = ReadonlyMap<string, ReviewedProviderRoute>;

export function reviewedRouteKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/** Index the reviewed facts, refusing a pair stated twice. */
export function indexReviewedProviderRoutes(
  routes: readonly ReviewedProviderRoute[] = KAANA_REVIEWED_PROVIDER_ROUTES,
): ReviewedProviderRouteIndex {
  const index = new Map<string, ReviewedProviderRoute>();
  for (const route of routes) {
    const key = reviewedRouteKey(route.provider, route.model);
    if (index.has(key)) {
      throw new Error(`reviewed provider route ${route.provider} ${route.model} is stated twice`);
    }
    index.set(key, route);
  }
  return index;
}
