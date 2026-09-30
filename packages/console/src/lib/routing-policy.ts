import {
  effectiveSameModelDeployment,
  powerLevelSchema,
  routingPolicySchema,
} from '@oxy.so/contracts'
import type {
  RoutingPolicy,
  RoutingProfile,
  UsageUnit,
} from '@oxy.so/contracts'

/**
 * Routing policy, as Console reads and writes it.
 *
 * The POLICY itself is `RoutingPolicy` from `@oxy.so/contracts` — the same schema
 * the API parses its own output with — so the controls cannot drift. What is
 * declared here is only the thin envelope
 * `/inference/routing-policies/*` wraps it in (`routingPolicyId`, `versionId`,
 * `status`), which lives in the API's own service module and is not part of the
 * published contract. Nothing about a control's MEANING is restated here.
 *
 * Two things this file deliberately does NOT do:
 *
 *  - It does not re-implement `routingPolicySchema`'s refinement. The contract
 *    owns which combinations are contradictory, and a second copy in the client
 *    is how the two come to disagree. The form makes a contradiction
 *    unexpressible where it can (a fallback switch that is off disables the
 *    same-model switch beneath it), and {@link routingPolicyControlIssues} runs
 *    the CONTRACT's own schema before a save, so a contradiction the form cannot
 *    prevent (a default power level outside the allowed list) is named before
 *    the request rather than after it.
 *  - It does not invent catalogue values. Every provider, region, licence and
 *    model reference the editor offers is derived from `GET /models`, and every
 *    power level / routing profile from `GET /models/routing-profiles`; with an
 *    empty catalogue the corresponding control renders an empty state rather
 *    than a free-text box that would write an id nobody can serve.
 */

/** One stored version of a policy, as the routing-policy routes return it. */
export interface StoredRoutingPolicy {
  readonly routingPolicyId: string
  readonly versionId: string
  readonly status: 'active' | 'archived'
  readonly policy: RoutingPolicy
}

/**
 * The fields a CUSTOMER may set, derived from the contract type by subtraction.
 *
 * Exactly the derivation `packages/api/src/schemas/inferenceRoutingPolicy.schemas.ts`
 * performs on its side: identity (`routingPolicyId`, `policyVersion`, `scope`),
 * the wire version and the server clock are the server's, and a body that could
 * set them would let a caller rewind their own version counter or re-point a
 * policy at another account. A control added to the contract and forgotten here
 * fails `tsc` in {@link controlsFromPolicy}.
 */
export type RoutingPolicyControls = Omit<
  RoutingPolicy,
  'schemaVersion' | 'routingPolicyId' | 'policyVersion' | 'scope' | 'updatedAt'
>

/** Read the editable controls off a stored policy. */
export function controlsFromPolicy(
  policy: RoutingPolicy,
): RoutingPolicyControls {
  return {
    defaultTarget: policy.defaultTarget,
    providerAllowlist: [...policy.providerAllowlist],
    providerDenylist: [...policy.providerDenylist],
    allowedRegions: [...policy.allowedRegions],
    deniedRegions: [...policy.deniedRegions],
    requireZeroDataRetention: policy.requireZeroDataRetention,
    prohibitTrainingOnCustomerData: policy.prohibitTrainingOnCustomerData,
    maxPricePerUnit: policy.maxPricePerUnit.map((ceiling) => ({ ...ceiling })),
    maxPricePerRequest: policy.maxPricePerRequest
      ? { ...policy.maxPricePerRequest }
      : undefined,
    optimiseFor: policy.optimiseFor,
    oxyHostedOnly: policy.oxyHostedOnly,
    allowedLicenseIds: [...policy.allowedLicenseIds],
    requireCommercialUseRights: policy.requireCommercialUseRights,
    fallback: {
      disabled: policy.fallback.disabled,
      sameModelDeployment: effectiveSameModelDeployment(policy.fallback),
      authorizedCrossModel: [...policy.fallback.authorizedCrossModel],
    },
    allowedRoutingProfileIds: [...policy.allowedRoutingProfileIds],
    byokPreference: policy.byokPreference,
    dedicatedCapacity: policy.dedicatedCapacity,
  }
}

/**
 * The controls a NEW policy starts from.
 *
 * Every constraint is off. A default that quietly narrowed routing would be a
 * restriction the customer never chose and would first show up as a request
 * nothing could serve. The one thing that IS on is same-model deployment
 * failover, which is an availability decision between two deployments of the
 * identical revision — not a substitution, and the contract's own default
 * posture.
 */
export function defaultRoutingPolicyControls(): RoutingPolicyControls {
  return {
    defaultTarget: undefined,
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    maxPricePerUnit: [],
    maxPricePerRequest: undefined,
    optimiseFor: 'balanced',
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallback: {
      disabled: false,
      sameModelDeployment: true,
      authorizedCrossModel: [],
    },
    allowedRoutingProfileIds: [],
    byokPreference: 'disabled',
    dedicatedCapacity: 'disabled',
  }
}

/** Where the policy in force for an application came from. */
export type EffectivePolicyOrigin = 'application' | 'account'

/**
 * Which of the two a resolved policy is.
 *
 * `GET /inference/routing-policies/applications/:id` reports this alongside the
 * policy, but the SDK's response unwrapping hands back the `data` field alone,
 * so the sibling never reaches a caller. Reading it off `scope.kind` is exact
 * rather than an approximation: the route resolves an application's OWN policy
 * first and falls back to the owning account's, and those are precisely the two
 * scopes `routingPolicyScopeSchema` can hold — an application-scoped policy
 * always carries `kind: 'application'`.
 */
export function effectivePolicyOrigin(
  stored: StoredRoutingPolicy,
): EffectivePolicyOrigin {
  return stored.policy.scope.kind === 'application' ? 'application' : 'account'
}

/** What to optimise for among the routes that qualify. */
export const OPTIMISE_FOR_OPTIONS = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'price', label: 'Price' },
  { value: 'latency', label: 'Latency' },
  { value: 'throughput', label: 'Throughput' },
] as const

/** Whether the customer's own provider credentials may or must be used. */
export const BYOK_PREFERENCE_OPTIONS = [
  { value: 'disabled', label: 'Do not use my provider credentials' },
  { value: 'prefer', label: 'Prefer my provider credentials' },
  { value: 'require', label: 'Require my provider credentials' },
] as const

/** Enterprise reserved capacity rather than shared endpoints. */
export const DEDICATED_CAPACITY_OPTIONS = [
  { value: 'disabled', label: 'Shared endpoints' },
  { value: 'prefer', label: 'Prefer dedicated capacity' },
  { value: 'require', label: 'Require dedicated capacity' },
] as const

/** Human labels for the metered units a price ceiling can be quoted against. */
export const USAGE_UNIT_LABELS: Readonly<Record<UsageUnit, string>> = {
  input_tokens: 'Input tokens',
  cached_input_tokens: 'Cached input tokens',
  output_tokens: 'Output tokens',
  reasoning_tokens: 'Reasoning tokens',
  requests: 'Requests',
  images: 'Images',
  audio_input_milliseconds: 'Audio input (ms)',
  audio_output_milliseconds: 'Audio output (ms)',
  video_milliseconds: 'Video (ms)',
  characters: 'Characters',
  embeddings: 'Embeddings',
  audio_input_tokens: 'Audio input tokens',
  cached_audio_input_tokens: 'Cached audio input tokens',
  audio_output_tokens: 'Audio output tokens',
  session_milliseconds: 'Session time (ms)',
}

/** A short line per constraint, for the read-only summary on the overview. */
export interface RoutingPolicyHighlight {
  readonly label: string
  readonly value: string
}

function listOrNone(values: ReadonlyArray<string>, none: string): string {
  return values.length > 0 ? values.join(', ') : none
}

/**
 * The policy's constraints in one flat list.
 *
 * Reads every control the contract carries, so a policy cannot appear less
 * restrictive on the overview than it is in the editor.
 */
export function routingPolicyHighlights(
  policy: RoutingPolicy,
  profiles: ReadonlyArray<RoutingProfile> = [],
): Array<RoutingPolicyHighlight> {
  const target =
    policy.defaultTarget === undefined
      ? 'Every request must name its own model'
      : policy.defaultTarget.kind === 'model'
        ? policy.defaultTarget.modelReference
        : routingProfileLabel(policy.defaultTarget.routingProfileId, profiles)

  const fallback = policy.fallback.disabled
    ? 'Disabled — a request that cannot be served on its route fails'
    : [
        effectiveSameModelDeployment(policy.fallback)
          ? 'Same-model deployment failover'
          : 'No same-model failover',
        policy.fallback.authorizedCrossModel.length > 0
          ? `Cross-model authorised: ${policy.fallback.authorizedCrossModel.join(', ')}`
          : 'No cross-model substitution authorised',
      ].join(' · ')

  const ceilings = [
    ...policy.maxPricePerUnit.map(
      (ceiling) =>
        `${USAGE_UNIT_LABELS[ceiling.unit]}: ${ceiling.amount} ${ceiling.currency} per ${ceiling.per}`,
    ),
    ...(policy.maxPricePerRequest
      ? [
          `Per request: ${policy.maxPricePerRequest.amount} ${policy.maxPricePerRequest.currency}`,
        ]
      : []),
  ]

  return [
    { label: 'Default target', value: target },
    {
      label: 'Power levels allowed',
      value:
        policy.allowedRoutingProfileIds.length > 0
          ? policy.allowedRoutingProfileIds
              .map((id) => routingProfileLabel(id, profiles))
              .join(', ')
          : 'Any (unrestricted)',
    },
    { label: 'Optimise for', value: policy.optimiseFor },
    {
      label: 'Providers allowed',
      value: listOrNone(policy.providerAllowlist, 'Any'),
    },
    {
      label: 'Providers denied',
      value: listOrNone(policy.providerDenylist, 'None'),
    },
    {
      label: 'Regions allowed',
      value: listOrNone(policy.allowedRegions, 'Any'),
    },
    {
      label: 'Regions denied',
      value: listOrNone(policy.deniedRegions, 'None'),
    },
    {
      label: 'Zero data retention',
      value: policy.requireZeroDataRetention ? 'Required' : 'Not required',
    },
    {
      label: 'Training on customer data',
      value: policy.prohibitTrainingOnCustomerData
        ? 'Prohibited'
        : 'Not prohibited',
    },
    { label: 'Oxy-hosted only', value: policy.oxyHostedOnly ? 'Yes' : 'No' },
    {
      label: 'Licences allowed',
      value: listOrNone(policy.allowedLicenseIds, 'Any'),
    },
    {
      label: 'Commercial use rights',
      value: policy.requireCommercialUseRights ? 'Required' : 'Not required',
    },
    { label: 'Price ceilings', value: listOrNone(ceilings, 'None') },
    { label: 'Fallback', value: fallback },
    { label: 'Your provider credentials', value: policy.byokPreference },
    { label: 'Dedicated capacity', value: policy.dedicatedCapacity },
  ]
}

/**
 * The licences present in a catalogue, for the licence allowlist control.
 *
 * Derived from the entries rather than from a hardcoded SPDX list, so the editor
 * never offers a licence that would select nothing. Sits beside
 * `catalogueFacets` in `model-catalogue-filters.ts` for the same reason and is
 * kept here because only the routing policy consumes it.
 */
export function catalogueLicences(
  entries: ReadonlyArray<{
    license: { licenseId: string; displayName: string }
  }>,
): Array<{ licenseId: string; displayName: string }> {
  const licences = new Map<string, string>()
  for (const entry of entries) {
    licences.set(entry.license.licenseId, entry.license.displayName)
  }
  return [...licences.entries()]
    .map(([licenseId, displayName]) => ({ licenseId, displayName }))
    .sort((left, right) => left.licenseId.localeCompare(right.licenseId))
}

/**
 * The model references a catalogue can supply, newest revision first per model.
 *
 * Both the model line (`<publisher>/<model>`, resolved to a revision by policy)
 * and each pinnable revision (`<publisher>/<model>@<revision>`, served exactly or
 * refused) are offered, because those are two genuinely different instructions.
 */
export function catalogueModelReferences(
  entries: ReadonlyArray<{
    modelId: string
    availableRevisions: ReadonlyArray<string>
  }>,
): Array<string> {
  const references: Array<string> = []
  for (const entry of entries) {
    references.push(entry.modelId)
    for (const revision of entry.availableRevisions) {
      references.push(`${entry.modelId}@${revision}`)
    }
  }
  return references
}

/* -------------------------------------------------------------------------- */
/*  Power levels (routing profiles) an application may use                    */
/* -------------------------------------------------------------------------- */

/**
 * How a routing profile id reads on the overview.
 *
 * A power level reads as `Power level: Instant (power-instant)`, any other
 * profile as `Routing profile: <name> (<id>)`. An id the catalogue does not
 * list right now (a level with no servable model at the moment) keeps its
 * bare id, so the summary never pretends to know more than it does.
 */
export function routingProfileLabel(
  routingProfileId: string,
  profiles: ReadonlyArray<RoutingProfile>,
): string {
  const profile = profiles.find(
    (candidate) => candidate.routingProfileId === routingProfileId,
  )
  if (profile === undefined) return `Routing profile ID: ${routingProfileId}`
  const kind =
    profile.powerLevel === undefined ? 'Routing profile' : 'Power level'
  return `${kind}: ${profile.displayName} (${routingProfileId})`
}

/** One checkbox in the "Power levels" control. */
export interface RoutingProfileOption {
  readonly routingProfileId: string
  readonly label: string
  readonly description?: string
  /** Present when the profile IS a power level. */
  readonly powerLevel?: RoutingProfile['powerLevel']
  /**
   * False for an id the policy already names but `GET /models/routing-profiles`
   * does not list right now — a level whose models are all momentarily
   * unservable is omitted there. It is still offered, so saving a new version
   * never silently drops it.
   */
  readonly listed: boolean
}

function ladderRank(profile: { powerLevel?: RoutingProfile['powerLevel'] }) {
  if (profile.powerLevel === undefined) return Number.MAX_SAFE_INTEGER
  return powerLevelSchema.options.indexOf(profile.powerLevel)
}

/**
 * The routing profiles the allowed-list control offers, in ladder order.
 *
 * Power levels come first in the contract's own order (`auto`, `instant`, …,
 * `ultra` — `powerLevelSchema.options`, not a list restated here), then any
 * other profile by slug, then every id the policy already references that the
 * catalogue does not list at the moment.
 */
export function routingProfileOptions(
  profiles: ReadonlyArray<RoutingProfile>,
  referenced: ReadonlyArray<string> = [],
): Array<RoutingProfileOption> {
  const listed = [...profiles]
    .sort(
      (left, right) =>
        ladderRank(left) - ladderRank(right) ||
        left.slug.localeCompare(right.slug),
    )
    .map((profile): RoutingProfileOption => ({
      routingProfileId: profile.routingProfileId,
      label: profile.displayName,
      description: profile.description,
      powerLevel: profile.powerLevel,
      listed: true,
    }))
  const known = new Set(listed.map((option) => option.routingProfileId))
  const unlisted = [...new Set(referenced)]
    .filter((id) => !known.has(id))
    .map((id): RoutingProfileOption => ({
      routingProfileId: id,
      label: id,
      listed: false,
    }))
  return [...listed, ...unlisted]
}

/**
 * Toggle one profile in the allowed list, keeping it duplicate-free and in the
 * order the options are shown — so a saved version reads the same way the
 * editor displayed it, and two saves of the same choice are byte-identical.
 */
export function toggleAllowedRoutingProfile(
  allowed: ReadonlyArray<string>,
  routingProfileId: string,
  order: ReadonlyArray<RoutingProfileOption>,
): Array<string> {
  const next = new Set(allowed)
  if (next.has(routingProfileId)) next.delete(routingProfileId)
  else next.add(routingProfileId)
  const position = (id: string) => {
    const index = order.findIndex((option) => option.routingProfileId === id)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return [...next].sort((left, right) => position(left) - position(right))
}

/**
 * Whether a profile may be chosen as the default under the current allowed
 * list: always when the list is empty (unrestricted), otherwise only when it
 * is on it.
 */
export function isRoutingProfileAllowed(
  allowed: ReadonlyArray<string>,
  routingProfileId: string,
): boolean {
  return allowed.length === 0 || allowed.includes(routingProfileId)
}

/** Human wording for the contract issues the editor can surface by path. */
const ISSUE_WORDING: ReadonlyArray<{
  readonly path: string
  readonly message: string
}> = [
  {
    path: 'defaultTarget.routingProfileId',
    message:
      'The default power level is not one of the allowed power levels. Allow it, or pick an allowed level as the default.',
  },
  {
    path: 'allowedRoutingProfileIds',
    message: 'Each power level can be allowed only once.',
  },
]

/**
 * The contract's own verdict on a set of controls, as sentences.
 *
 * Runs `routingPolicySchema` itself — refinements included — over the controls
 * with placeholder server-owned fields, so the client check cannot disagree
 * with the API: it IS the API's rule. Identity fields are placeholders the
 * server overwrites and are never reported on. An empty result means the
 * contract accepts the controls; the API may still refuse for reasons only it
 * can know (an id it does not serve, a permission).
 */
export function routingPolicyControlIssues(
  controls: RoutingPolicyControls,
): Array<string> {
  const result = routingPolicySchema.safeParse({
    ...controls,
    schemaVersion: 2,
    routingPolicyId: 'draft',
    policyVersion: 1,
    scope: { kind: 'account', accountId: 'draft' },
    updatedAt: new Date(0).toISOString(),
  })
  if (result.success) return []
  const messages = result.error.issues.map((issue) => {
    const path = issue.path.join('.')
    const worded = ISSUE_WORDING.find(
      (entry) => path === entry.path || path.startsWith(`${entry.path}.`),
    )
    return worded ? worded.message : `${path || 'policy'}: ${issue.message}`
  })
  return [...new Set(messages)]
}
