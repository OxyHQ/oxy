import { useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Add01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import {
  USAGE_UNITS,
  currencyCodeSchema,
  exactDecimalSchema,
} from '@oxyhq/contracts'
import type { ReactNode } from 'react'
import type {
  ModelCatalogueEntry,
  RoutingProfile,
  UnitPrice,
  UsageUnit,
} from '@oxyhq/contracts'
import type { RoutingPolicyControls } from '@/lib/routing-policy'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { catalogueFacets } from '@/lib/model-catalogue-filters'
import {
  BYOK_PREFERENCE_OPTIONS,
  DEDICATED_CAPACITY_OPTIONS,
  OPTIMISE_FOR_OPTIONS,
  USAGE_UNIT_LABELS,
  catalogueLicences,
  catalogueModelReferences,
} from '@/lib/routing-policy'

/**
 * The routing policy editor.
 *
 * Three rules shape it, and each one shows up as a structural property of the
 * form rather than as a warning somebody has to read:
 *
 *  - **A contradiction is unexpressible, not validated.** Turning fallback off
 *    disables the same-model switch and clears the cross-model list, because the
 *    contract rejects a policy that disables fallback and then configures one.
 *    The client does not re-implement `routingPolicySchema`'s refinement — a
 *    second copy of a rule is how two copies come to disagree — so anything that
 *    still reaches the API is answered by the API's own issue list.
 *  - **Nothing is invented.** Providers, regions, licences and model references
 *    all come from `GET /models`. The catalogue is empty today, so those
 *    controls render an empty state instead of a text box that would write an id
 *    Oxy cannot serve.
 *  - **Money is exact.** Amounts are edited as text and parsed with the
 *    contract's own `exactDecimalSchema` — the same schema the ledger's NUMERIC
 *    columns are declared against — so a value that would silently become a
 *    float is refused here with the field named.
 */

interface RoutingPolicyFormProps {
  initial: RoutingPolicyControls
  submitLabel: string
  isPending: boolean
  catalogue: ReadonlyArray<ModelCatalogueEntry>
  routingProfiles: ReadonlyArray<RoutingProfile>
  onSubmit: (controls: RoutingPolicyControls) => void
  onCancel: () => void
}

/** One price ceiling as it is being edited: amounts are text until parsed. */
interface PriceCeilingDraft {
  unit: UsageUnit
  amount: string
  per: string
}

function ceilingDrafts(
  ceilings: ReadonlyArray<UnitPrice>,
): Array<PriceCeilingDraft> {
  return ceilings.map((ceiling) => ({
    unit: ceiling.unit,
    amount: ceiling.amount,
    per: String(ceiling.per),
  }))
}

export function RoutingPolicyForm({
  initial,
  submitLabel,
  isPending,
  catalogue,
  routingProfiles,
  onSubmit,
  onCancel,
}: RoutingPolicyFormProps) {
  const [controls, setControls] = useState<RoutingPolicyControls>(initial)
  // Every ceiling in one policy shares a currency, so reading the first one
  // reads all of them — that agreement is the contract's rule and the price-cap
  // table's own column.
  const [currency, setCurrency] = useState<string>(
    initial.maxPricePerRequest?.currency ??
      initial.maxPricePerUnit.at(0)?.currency ??
      'USD',
  )
  const [perUnit, setPerUnit] = useState<Array<PriceCeilingDraft>>(
    ceilingDrafts(initial.maxPricePerUnit),
  )
  const [perRequest, setPerRequest] = useState<string>(
    initial.maxPricePerRequest?.amount ?? '',
  )
  const [errors, setErrors] = useState<Array<string>>([])

  const facets = catalogueFacets(catalogue)
  const licences = catalogueLicences(catalogue)
  const modelReferences = catalogueModelReferences(catalogue)

  const patch = (next: Partial<RoutingPolicyControls>) => {
    setControls((current) => ({ ...current, ...next }))
  }

  const toggleIn = (
    key:
      | 'providerAllowlist'
      | 'providerDenylist'
      | 'allowedRegions'
      | 'deniedRegions'
      | 'allowedLicenseIds',
    value: string,
  ) => {
    setControls((current) => {
      const list = current[key]
      return {
        ...current,
        [key]: list.includes(value)
          ? list.filter((item) => item !== value)
          : [...list, value],
      }
    })
  }

  const toggleCrossModel = (reference: string) => {
    setControls((current) => {
      const list = current.fallback.authorizedCrossModel
      return {
        ...current,
        fallback: {
          ...current.fallback,
          authorizedCrossModel: list.includes(reference)
            ? list.filter((item) => item !== reference)
            : [...list, reference],
        },
      }
    })
  }

  /**
   * Disabling fallback also clears what it would have configured.
   *
   * The contract refuses "fallback is off AND same-model failover is on" and
   * "fallback is off AND these substitutes are authorised" — leaving stale
   * values behind would mean a form that looks saveable and is not.
   */
  const setFallbackDisabled = (disabled: boolean) => {
    setControls((current) => ({
      ...current,
      fallback: disabled
        ? {
            disabled: true,
            sameModelDeployment: false,
            authorizedCrossModel: [],
          }
        : { ...current.fallback, disabled: false },
    }))
  }

  const setDefaultTarget = (value: string) => {
    if (value === 'none') {
      patch({ defaultTarget: undefined })
      return
    }
    if (value.startsWith('profile:')) {
      patch({
        defaultTarget: {
          kind: 'routing_profile_id',
          routingProfileId: value.slice('profile:'.length),
        },
      })
      return
    }
    patch({
      defaultTarget: {
        kind: 'model',
        modelReference: value.slice('model:'.length),
      },
    })
  }

  const defaultTargetValue =
    controls.defaultTarget === undefined
      ? 'none'
      : controls.defaultTarget.kind === 'model'
        ? `model:${controls.defaultTarget.modelReference}`
        : `profile:${controls.defaultTarget.routingProfileId}`

  const handleSubmit = () => {
    const problems: Array<string> = []

    const hasCeilings = perUnit.length > 0 || perRequest.trim() !== ''
    const currencyResult = currencyCodeSchema.safeParse(
      currency.trim().toUpperCase(),
    )
    if (hasCeilings && !currencyResult.success) {
      problems.push(
        'Currency must be an ISO 4217 alpha-3 code, for example USD.',
      )
    }

    const ceilings: Array<UnitPrice> = []
    for (const draft of perUnit) {
      const amount = exactDecimalSchema.safeParse(draft.amount.trim())
      if (!amount.success) {
        problems.push(
          `${USAGE_UNIT_LABELS[draft.unit]}: the ceiling must be an exact decimal such as 0.000003, without an exponent.`,
        )
        continue
      }
      const per = Number(draft.per.trim())
      if (!Number.isSafeInteger(per) || per <= 0) {
        problems.push(
          `${USAGE_UNIT_LABELS[draft.unit]}: "per" must be a positive whole number.`,
        )
        continue
      }
      if (currencyResult.success) {
        ceilings.push({
          unit: draft.unit,
          amount: amount.data,
          per,
          currency: currencyResult.data,
        })
      }
    }

    let perRequestCeiling: RoutingPolicyControls['maxPricePerRequest']
    if (perRequest.trim() !== '') {
      const amount = exactDecimalSchema.safeParse(perRequest.trim())
      if (!amount.success) {
        problems.push(
          'Per-request ceiling: the amount must be an exact decimal such as 0.05, without an exponent.',
        )
      } else if (currencyResult.success) {
        perRequestCeiling = {
          amount: amount.data,
          currency: currencyResult.data,
        }
      }
    }

    if (problems.length > 0) {
      setErrors(problems)
      return
    }

    setErrors([])
    onSubmit({
      ...controls,
      maxPricePerUnit: ceilings,
      maxPricePerRequest: perRequestCeiling,
    })
  }

  const unusedUnits = USAGE_UNITS.filter(
    (unit) => !perUnit.some((draft) => draft.unit === unit),
  )

  return (
    <div className="space-y-8">
      {errors.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
          <p className="text-sm font-medium text-destructive">
            This policy cannot be saved yet
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-destructive/90">
            {errors.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <FormSection
        title="Default target"
        description="What a request resolves to when the caller names no model. A routing profile is a strategy for choosing among routes; it is never a model."
      >
        {modelReferences.length === 0 && routingProfiles.length === 0 ? (
          <EmptyControl>
            No model or routing profile is published yet, so there is nothing to
            default to. Every request will have to name its own model.
          </EmptyControl>
        ) : (
          <Select value={defaultTargetValue} onValueChange={setDefaultTarget}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                Every request must name its own model
              </SelectItem>
              {routingProfiles.map((profile) => (
                <SelectItem
                  key={`profile:${profile.routingProfileId}`}
                  value={`profile:${profile.routingProfileId}`}
                >
                  Routing profile — {profile.displayName}
                </SelectItem>
              ))}
              {modelReferences.map((reference) => (
                <SelectItem
                  key={`model:${reference}`}
                  value={`model:${reference}`}
                >
                  {reference}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormSection>

      <FormSection
        title="Providers"
        description="An empty allowlist means every provider qualifies. A provider named in both lists is a policy that can never resolve, and the API refuses it."
      >
        <TokenGroup
          label="Allowed"
          options={facets.providers.map((provider) => ({
            value: provider.slug,
            label: provider.displayName,
          }))}
          selected={controls.providerAllowlist}
          onToggle={(value) => toggleIn('providerAllowlist', value)}
          empty="No serving provider is published yet."
        />
        <TokenGroup
          label="Denied"
          options={facets.providers.map((provider) => ({
            value: provider.slug,
            label: provider.displayName,
          }))}
          selected={controls.providerDenylist}
          onToggle={(value) => toggleIn('providerDenylist', value)}
          empty="No serving provider is published yet."
        />
      </FormSection>

      <FormSection
        title="Regions"
        description="Where a request may be served. An empty allowlist means no residency constraint."
      >
        <TokenGroup
          label="Allowed"
          options={facets.regions.map((region) => ({
            value: region,
            label: region,
          }))}
          selected={controls.allowedRegions}
          onToggle={(value) => toggleIn('allowedRegions', value)}
          empty="No region is published yet."
        />
        <TokenGroup
          label="Denied"
          options={facets.regions.map((region) => ({
            value: region,
            label: region,
          }))}
          selected={controls.deniedRegions}
          onToggle={(value) => toggleIn('deniedRegions', value)}
          empty="No region is published yet."
        />
      </FormSection>

      <FormSection
        title="Data handling"
        description="Constraints on what a route may do with your data."
      >
        <ToggleRow
          label="Require zero data retention"
          description="Only route to endpoints that retain nothing after answering."
          checked={controls.requireZeroDataRetention}
          onCheckedChange={(checked) =>
            patch({ requireZeroDataRetention: checked })
          }
        />
        <ToggleRow
          label="Prohibit training on customer data"
          description="Exclude any route whose provider trains on what you send it."
          checked={controls.prohibitTrainingOnCustomerData}
          onCheckedChange={(checked) =>
            patch({ prohibitTrainingOnCustomerData: checked })
          }
        />
      </FormSection>

      <FormSection
        title="Selection"
        description="What to optimise for among the routes that qualify, and what kind of capacity to run on."
      >
        <LabelledSelect
          id="routing-optimise-for"
          label="Optimise for"
          value={controls.optimiseFor}
          options={OPTIMISE_FOR_OPTIONS}
          onValueChange={(value) =>
            patch({
              optimiseFor: value as RoutingPolicyControls['optimiseFor'],
            })
          }
        />
        <LabelledSelect
          id="routing-dedicated-capacity"
          label="Capacity"
          value={controls.dedicatedCapacity}
          options={DEDICATED_CAPACITY_OPTIONS}
          onValueChange={(value) =>
            patch({
              dedicatedCapacity:
                value as RoutingPolicyControls['dedicatedCapacity'],
            })
          }
        />
        <LabelledSelect
          id="routing-byok-preference"
          label="Your provider credentials"
          value={controls.byokPreference}
          options={BYOK_PREFERENCE_OPTIONS}
          onValueChange={(value) =>
            patch({
              byokPreference: value as RoutingPolicyControls['byokPreference'],
            })
          }
        />
        <ToggleRow
          label="Oxy-hosted only"
          description="Serve only from Oxy's own hosting of open-weight models. Cannot be combined with requiring your own provider credentials."
          checked={controls.oxyHostedOnly}
          onCheckedChange={(checked) => patch({ oxyHostedOnly: checked })}
        />
      </FormSection>

      <FormSection
        title="Licensing"
        description="Constraints on the licence a model is published under. An empty licence list is unconstrained."
      >
        <ToggleRow
          label="Require commercial use rights"
          description="Exclude models whose licence does not permit commercial use."
          checked={controls.requireCommercialUseRights}
          onCheckedChange={(checked) =>
            patch({ requireCommercialUseRights: checked })
          }
        />
        <TokenGroup
          label="Allowed licences"
          options={licences.map((licence) => ({
            value: licence.licenseId,
            label: licence.displayName,
          }))}
          selected={controls.allowedLicenseIds}
          onToggle={(value) => toggleIn('allowedLicenseIds', value)}
          empty="No licence is published yet."
        />
      </FormSection>

      <FormSection
        title="Price ceilings"
        description="What a route may cost you. Amounts are exact decimals, never rounded here, and every ceiling in one policy shares a currency."
      >
        <div className="max-w-40 space-y-1.5">
          <Label htmlFor="routing-currency" className="text-sm">
            Currency
          </Label>
          <Input
            id="routing-currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            placeholder="USD"
            maxLength={3}
          />
        </div>

        <div className="max-w-60 space-y-1.5">
          <Label htmlFor="routing-per-request" className="text-sm">
            Maximum per request
          </Label>
          <Input
            id="routing-per-request"
            value={perRequest}
            onChange={(event) => setPerRequest(event.target.value)}
            placeholder="No ceiling"
            inputMode="decimal"
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Per unit</p>
          {perUnit.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No per-unit ceiling.
            </p>
          ) : (
            <div className="space-y-2">
              {perUnit.map((draft, index) => (
                <div
                  key={draft.unit}
                  className="flex flex-wrap items-end gap-2"
                >
                  <div className="w-44 space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Unit
                    </Label>
                    <p className="text-sm text-foreground">
                      {USAGE_UNIT_LABELS[draft.unit]}
                    </p>
                  </div>
                  <div className="w-40 space-y-1">
                    <Label
                      htmlFor={`routing-ceiling-amount-${draft.unit}`}
                      className="text-xs text-muted-foreground"
                    >
                      Amount
                    </Label>
                    <Input
                      id={`routing-ceiling-amount-${draft.unit}`}
                      value={draft.amount}
                      inputMode="decimal"
                      onChange={(event) => {
                        const value = event.target.value
                        setPerUnit((current) =>
                          current.map((item, position) =>
                            position === index
                              ? { ...item, amount: value }
                              : item,
                          ),
                        )
                      }}
                    />
                  </div>
                  <div className="w-28 space-y-1">
                    <Label
                      htmlFor={`routing-ceiling-per-${draft.unit}`}
                      className="text-xs text-muted-foreground"
                    >
                      Per
                    </Label>
                    <Input
                      id={`routing-ceiling-per-${draft.unit}`}
                      value={draft.per}
                      inputMode="numeric"
                      onChange={(event) => {
                        const value = event.target.value
                        setPerUnit((current) =>
                          current.map((item, position) =>
                            position === index ? { ...item, per: value } : item,
                          ),
                        )
                      }}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove the ${USAGE_UNIT_LABELS[draft.unit]} ceiling`}
                    onClick={() =>
                      setPerUnit((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={16} />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {unusedUnits.length > 0 && (
            <Select
              value=""
              onValueChange={(unit) =>
                setPerUnit((current) => [
                  ...current,
                  { unit: unit as UsageUnit, amount: '', per: '1000000' },
                ])
              }
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Add a per-unit ceiling" />
              </SelectTrigger>
              <SelectContent>
                {unusedUnits.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {USAGE_UNIT_LABELS[unit]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </FormSection>

      <FormSection
        title="Fallback"
        description="Moving between two deployments of the same revision is an availability decision. Serving a DIFFERENT model is a substitution you have to authorise by name, and a switch that uses one is recorded where you can read it."
      >
        <ToggleRow
          label="Fail rather than fall back"
          description="A request that cannot be served on its route fails instead of moving."
          checked={controls.fallback.disabled}
          onCheckedChange={setFallbackDisabled}
        />
        <ToggleRow
          label="Same-model deployment failover"
          description="Move between deployments of the identical revision when one is unavailable."
          checked={controls.fallback.sameModelDeployment}
          disabled={controls.fallback.disabled}
          onCheckedChange={(checked) =>
            setControls((current) => ({
              ...current,
              fallback: { ...current.fallback, sameModelDeployment: checked },
            }))
          }
        />
        {!controls.fallback.disabled && (
          <TokenGroup
            label="Authorised cross-model substitutes"
            options={modelReferences.map((reference) => ({
              value: reference,
              label: reference,
            }))}
            selected={controls.fallback.authorizedCrossModel}
            onToggle={toggleCrossModel}
            empty="No model is published yet, so there is nothing to authorise as a substitute."
          />
        )}
      </FormSection>

      <div className="flex items-center gap-2">
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? 'Saving…' : submitLabel}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="space-y-4">
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

function EmptyControl({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

function LabelledSelect({
  id,
  label,
  value,
  options,
  onValueChange,
}: {
  id: string
  label: string
  value: string
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  onValueChange: (value: string) => void
}) {
  return (
    <div className="max-w-md space-y-1.5">
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * A set of toggle chips over options DERIVED from the catalogue.
 *
 * There is deliberately no free-text entry: a value typed here would be written
 * into a policy against a provider, region or licence that does not exist, and
 * the policy would then match nothing while looking configured.
 */
function TokenGroup({
  label,
  options,
  selected,
  onToggle,
  empty,
}: {
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  selected: ReadonlyArray<string>
  onToggle: (value: string) => void
  empty: string
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => {
            const isSelected = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onToggle(option.value)}
                aria-pressed={isSelected}
              >
                <Badge variant={isSelected ? 'default' : 'outline'}>
                  {option.label}
                  {isSelected && (
                    <HugeiconsIcon icon={Cancel01Icon} size={12} />
                  )}
                  {!isSelected && <HugeiconsIcon icon={Add01Icon} size={12} />}
                </Badge>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
