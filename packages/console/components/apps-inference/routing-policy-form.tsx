import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { USAGE_UNITS, currencyCodeSchema, exactDecimalSchema } from '@oxy.so/contracts';
import type { ModelCatalogueEntry, RoutingProfile, UnitPrice, UsageUnit } from '@oxy.so/contracts';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Chip } from '@oxy.so/bloom/chip';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { Switch } from '@oxy.so/bloom/switch';
import type { RoutingPolicyControls, RoutingProfileOption } from '@/lib/routing-policy';
import { useTranslation } from '@/lib/i18n';
import { catalogueFacets } from '@/lib/model-catalogue-filters';
import {
  BYOK_PREFERENCE_OPTIONS,
  DEDICATED_CAPACITY_OPTIONS,
  OPTIMISE_FOR_OPTIONS,
  USAGE_UNIT_LABELS,
  catalogueLicences,
  catalogueModelReferences,
  isRoutingProfileAllowed,
  routingPolicyControlIssues,
  routingProfileOptions,
  toggleAllowedRoutingProfile,
} from '@/lib/routing-policy';
import { MutedText, SelectField, TextInputField } from './ui';

/**
 * The routing policy editor.
 *
 * Three rules shape it, and each one shows up as a structural property of the
 * form rather than as a warning somebody has to read:
 *
 *  - **A contradiction is unexpressible where it can be.** Turning fallback off
 *    disables the same-model switch and clears the cross-model list, because the
 *    contract rejects a policy that disables fallback and then configures one.
 *    A power level outside a non-empty allowed list is disabled in the default
 *    picker. What the form cannot prevent (un-ticking the level that is already
 *    the default) is caught before saving by running the CONTRACT's own schema
 *    (`routingPolicyControlIssues`) — never a second copy of its rule.
 *  - **Nothing is invented.** Providers, regions, licences and model references
 *    all come from `GET /models`; power levels and routing profiles from
 *    `GET /models/routing-profiles`. An empty catalogue renders an empty state
 *    instead of a text box that would write an id Oxy cannot serve.
 *  - **Money is exact.** Amounts are edited as text and parsed with the
 *    contract's own `exactDecimalSchema` — the same schema the ledger's NUMERIC
 *    columns are declared against — so a value that would silently become a
 *    float is refused here with the field named.
 */

export interface RoutingPolicyFormProps {
  initial: RoutingPolicyControls;
  submitLabel: string;
  isPending: boolean;
  catalogue: ReadonlyArray<ModelCatalogueEntry>;
  routingProfiles: ReadonlyArray<RoutingProfile>;
  onSubmit: (controls: RoutingPolicyControls) => void;
  onCancel: () => void;
}

/** One price ceiling as it is being edited: amounts are text until parsed. */
interface PriceCeilingDraft {
  unit: UsageUnit;
  amount: string;
  per: string;
}

type ListKey =
  | 'providerAllowlist'
  | 'providerDenylist'
  | 'allowedRegions'
  | 'deniedRegions'
  | 'allowedLicenseIds';

function ceilingDrafts(ceilings: ReadonlyArray<UnitPrice>): Array<PriceCeilingDraft> {
  return ceilings.map((ceiling) => ({
    unit: ceiling.unit,
    amount: ceiling.amount,
    per: String(ceiling.per),
  }));
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
  const { t } = useTranslation();
  const [controls, setControls] = useState<RoutingPolicyControls>(initial);
  // Every ceiling in one policy shares a currency, so reading the first one
  // reads all of them — that agreement is the contract's rule and the price-cap
  // table's own column.
  const [currency, setCurrency] = useState<string>(
    initial.maxPricePerRequest?.currency ?? initial.maxPricePerUnit.at(0)?.currency ?? 'USD',
  );
  const [perUnit, setPerUnit] = useState<Array<PriceCeilingDraft>>(
    ceilingDrafts(initial.maxPricePerUnit),
  );
  const [perRequest, setPerRequest] = useState<string>(initial.maxPricePerRequest?.amount ?? '');
  const [errors, setErrors] = useState<Array<string>>([]);

  const facets = catalogueFacets(catalogue);
  const licences = catalogueLicences(catalogue);
  const modelReferences = catalogueModelReferences(catalogue);
  const profileOptions = routingProfileOptions(routingProfiles, [
    ...initial.allowedRoutingProfileIds,
    ...(initial.defaultTarget?.kind === 'routing_profile_id'
      ? [initial.defaultTarget.routingProfileId]
      : []),
  ]);
  const powerLevelOptions = profileOptions.filter(
    (option) => option.powerLevel !== undefined || !option.listed,
  );
  const otherProfileOptions = profileOptions.filter(
    (option) => option.powerLevel === undefined && option.listed,
  );
  const defaultProfileId =
    controls.defaultTarget?.kind === 'routing_profile_id'
      ? controls.defaultTarget.routingProfileId
      : undefined;
  const defaultOutsideAllowed =
    defaultProfileId !== undefined &&
    !isRoutingProfileAllowed(controls.allowedRoutingProfileIds, defaultProfileId);

  const toggleAllowedProfile = (routingProfileId: string) => {
    setControls((current) => ({
      ...current,
      allowedRoutingProfileIds: toggleAllowedRoutingProfile(
        current.allowedRoutingProfileIds,
        routingProfileId,
        profileOptions,
      ),
    }));
  };

  const patch = (next: Partial<RoutingPolicyControls>) => {
    setControls((current) => ({ ...current, ...next }));
  };

  const toggleIn = (key: ListKey, value: string) => {
    setControls((current) => {
      const list = current[key];
      return {
        ...current,
        [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value],
      };
    });
  };

  const toggleCrossModel = (reference: string) => {
    setControls((current) => {
      const list = current.fallback.authorizedCrossModel;
      return {
        ...current,
        fallback: {
          ...current.fallback,
          authorizedCrossModel: list.includes(reference)
            ? list.filter((item) => item !== reference)
            : [...list, reference],
        },
      };
    });
  };

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
        ? { disabled: true, sameModelDeployment: false, authorizedCrossModel: [] }
        : { ...current.fallback, disabled: false },
    }));
  };

  const setDefaultTarget = (value: string) => {
    if (value === 'none') {
      patch({ defaultTarget: undefined });
      return;
    }
    if (value.startsWith('profile:')) {
      patch({
        defaultTarget: {
          kind: 'routing_profile_id',
          routingProfileId: value.slice('profile:'.length),
        },
      });
      return;
    }
    patch({ defaultTarget: { kind: 'model', modelReference: value.slice('model:'.length) } });
  };

  const defaultTargetValue =
    controls.defaultTarget === undefined
      ? 'none'
      : controls.defaultTarget.kind === 'model'
        ? `model:${controls.defaultTarget.modelReference}`
        : `profile:${controls.defaultTarget.routingProfileId}`;

  const profileItem = (option: RoutingProfileOption, prefix: string) => ({
    value: `profile:${option.routingProfileId}`,
    label: `${prefix} — ${option.label}`,
    disabled:
      !isRoutingProfileAllowed(controls.allowedRoutingProfileIds, option.routingProfileId) &&
      option.routingProfileId !== defaultProfileId,
  });
  const defaultTargetItems = [
    { value: 'none', label: t('appsInference.form.default.none'), disabled: false },
    ...powerLevelOptions.map((option) =>
      profileItem(option, t('appsInference.form.default.powerLevelPrefix')),
    ),
    ...otherProfileOptions.map((option) =>
      profileItem(option, t('appsInference.form.default.profilePrefix')),
    ),
    ...modelReferences.map((reference) => ({
      value: `model:${reference}`,
      label: reference,
      disabled: false,
    })),
  ];

  const handleSubmit = () => {
    const problems: Array<string> = [];

    const hasCeilings = perUnit.length > 0 || perRequest.trim() !== '';
    const currencyResult = currencyCodeSchema.safeParse(currency.trim().toUpperCase());
    if (hasCeilings && !currencyResult.success) {
      problems.push(t('appsInference.form.errors.currency'));
    }

    const ceilings: Array<UnitPrice> = [];
    for (const draft of perUnit) {
      const unitLabel = USAGE_UNIT_LABELS[draft.unit];
      const amount = exactDecimalSchema.safeParse(draft.amount.trim());
      if (!amount.success) {
        problems.push(t('appsInference.form.errors.unitAmount', { unit: unitLabel }));
        continue;
      }
      const per = Number(draft.per.trim());
      if (!Number.isSafeInteger(per) || per <= 0) {
        problems.push(t('appsInference.form.errors.unitPer', { unit: unitLabel }));
        continue;
      }
      if (currencyResult.success) {
        ceilings.push({
          unit: draft.unit,
          amount: amount.data,
          per,
          currency: currencyResult.data,
        });
      }
    }

    let perRequestCeiling: RoutingPolicyControls['maxPricePerRequest'];
    if (perRequest.trim() !== '') {
      const amount = exactDecimalSchema.safeParse(perRequest.trim());
      if (!amount.success) {
        problems.push(t('appsInference.form.errors.requestAmount'));
      } else if (currencyResult.success) {
        perRequestCeiling = { amount: amount.data, currency: currencyResult.data };
      }
    }

    const next: RoutingPolicyControls = {
      ...controls,
      maxPricePerUnit: ceilings,
      maxPricePerRequest: perRequestCeiling,
    };
    // Only once every field parsed: a half-built draft would be reported
    // twice, once in the field's own words and once in the contract's.
    if (problems.length === 0) {
      problems.push(...routingPolicyControlIssues(next));
    }

    if (problems.length > 0) {
      setErrors(problems);
      return;
    }

    setErrors([]);
    onSubmit(next);
  };

  const unusedUnits = USAGE_UNITS.filter((unit) => !perUnit.some((draft) => draft.unit === unit));
  const providerOptions = facets.providers.map((provider) => ({
    value: provider.slug,
    label: provider.displayName,
  }));
  const regionOptions = facets.regions.map((region) => ({ value: region, label: region }));

  const updateDraft = (index: number, change: Partial<PriceCeilingDraft>) => {
    setPerUnit((current) =>
      current.map((item, position) => (position === index ? { ...item, ...change } : item)),
    );
  };

  return (
    <View className="gap-8">
      {errors.length > 0 && (
        <View role="alert" className="gap-1 rounded-lg border border-destructive bg-muted p-3">
          <Text className="text-sm font-medium text-destructive">
            {t('appsInference.form.errors.title')}
          </Text>
          {errors.map((problem) => (
            <Text key={problem} className="text-xs text-destructive">
              {`• ${problem}`}
            </Text>
          ))}
        </View>
      )}

      <FormSection
        title={t('appsInference.form.power.title')}
        description={t('appsInference.form.power.description')}
      >
        {powerLevelOptions.length === 0 && otherProfileOptions.length === 0 ? (
          <EmptyControl>{t('appsInference.form.power.empty')}</EmptyControl>
        ) : (
          <>
            <MutedText small>
              {controls.allowedRoutingProfileIds.length === 0
                ? t('appsInference.form.power.unrestricted')
                : t('appsInference.form.power.restricted')}
            </MutedText>
            <ProfileCheckboxGroup
              label={t('appsInference.form.power.allowedLevels')}
              options={powerLevelOptions}
              selected={controls.allowedRoutingProfileIds}
              onToggle={toggleAllowedProfile}
              unlistedNote={t('appsInference.form.power.unlisted')}
            />
            {otherProfileOptions.length > 0 && (
              <ProfileCheckboxGroup
                label={t('appsInference.form.power.otherProfiles')}
                options={otherProfileOptions}
                selected={controls.allowedRoutingProfileIds}
                onToggle={toggleAllowedProfile}
                unlistedNote={t('appsInference.form.power.unlisted')}
              />
            )}
            {controls.allowedRoutingProfileIds.length > 0 && (
              <View className="flex-row">
                <Button
                  appearance="plain"
                  size="sm"
                  onPress={() => patch({ allowedRoutingProfileIds: [] })}
                >
                  {t('appsInference.form.power.clear')}
                </Button>
              </View>
            )}
          </>
        )}
      </FormSection>

      <FormSection
        title={t('appsInference.form.default.title')}
        description={t('appsInference.form.default.description')}
      >
        {modelReferences.length === 0 && profileOptions.length === 0 ? (
          <EmptyControl>{t('appsInference.form.default.empty')}</EmptyControl>
        ) : (
          <View className="gap-2">
            <SelectField
              label={t('appsInference.form.default.label')}
              value={defaultTargetValue}
              items={defaultTargetItems}
              onChange={setDefaultTarget}
              invalid={defaultOutsideAllowed}
            />
            {defaultOutsideAllowed && (
              <Text role="alert" className="text-xs text-destructive">
                {t('appsInference.form.default.outsideAllowed')}
              </Text>
            )}
          </View>
        )}
      </FormSection>

      <FormSection
        title={t('appsInference.form.providers.title')}
        description={t('appsInference.form.providers.description')}
      >
        <TokenGroup
          label={t('appsInference.form.allowed')}
          options={providerOptions}
          selected={controls.providerAllowlist}
          onToggle={(value) => toggleIn('providerAllowlist', value)}
          empty={t('appsInference.form.providers.empty')}
        />
        <TokenGroup
          label={t('appsInference.form.denied')}
          options={providerOptions}
          selected={controls.providerDenylist}
          onToggle={(value) => toggleIn('providerDenylist', value)}
          empty={t('appsInference.form.providers.empty')}
        />
      </FormSection>

      <FormSection
        title={t('appsInference.form.regions.title')}
        description={t('appsInference.form.regions.description')}
      >
        <TokenGroup
          label={t('appsInference.form.allowed')}
          options={regionOptions}
          selected={controls.allowedRegions}
          onToggle={(value) => toggleIn('allowedRegions', value)}
          empty={t('appsInference.form.regions.empty')}
        />
        <TokenGroup
          label={t('appsInference.form.denied')}
          options={regionOptions}
          selected={controls.deniedRegions}
          onToggle={(value) => toggleIn('deniedRegions', value)}
          empty={t('appsInference.form.regions.empty')}
        />
      </FormSection>

      <FormSection
        title={t('appsInference.form.data.title')}
        description={t('appsInference.form.data.description')}
      >
        <ToggleRow
          label={t('appsInference.form.data.zeroRetention.label')}
          description={t('appsInference.form.data.zeroRetention.description')}
          checked={controls.requireZeroDataRetention}
          onCheckedChange={(checked) => patch({ requireZeroDataRetention: checked })}
        />
        <ToggleRow
          label={t('appsInference.form.data.noTraining.label')}
          description={t('appsInference.form.data.noTraining.description')}
          checked={controls.prohibitTrainingOnCustomerData}
          onCheckedChange={(checked) => patch({ prohibitTrainingOnCustomerData: checked })}
        />
      </FormSection>

      <FormSection
        title={t('appsInference.form.selection.title')}
        description={t('appsInference.form.selection.description')}
      >
        <SelectField
          label={t('appsInference.form.selection.optimiseFor')}
          value={controls.optimiseFor}
          items={OPTIMISE_FOR_OPTIONS}
          onChange={(value) => patch({ optimiseFor: value })}
        />
        <SelectField
          label={t('appsInference.form.selection.capacity')}
          value={controls.dedicatedCapacity}
          items={DEDICATED_CAPACITY_OPTIONS}
          onChange={(value) => patch({ dedicatedCapacity: value })}
        />
        <SelectField
          label={t('appsInference.form.selection.byok')}
          value={controls.byokPreference}
          items={BYOK_PREFERENCE_OPTIONS}
          onChange={(value) => patch({ byokPreference: value })}
        />
        <ToggleRow
          label={t('appsInference.form.selection.hostedOnly.label')}
          description={t('appsInference.form.selection.hostedOnly.description')}
          checked={controls.oxyHostedOnly}
          onCheckedChange={(checked) => patch({ oxyHostedOnly: checked })}
        />
      </FormSection>

      <FormSection
        title={t('appsInference.form.licensing.title')}
        description={t('appsInference.form.licensing.description')}
      >
        <ToggleRow
          label={t('appsInference.form.licensing.commercial.label')}
          description={t('appsInference.form.licensing.commercial.description')}
          checked={controls.requireCommercialUseRights}
          onCheckedChange={(checked) => patch({ requireCommercialUseRights: checked })}
        />
        <TokenGroup
          label={t('appsInference.form.licensing.allowed')}
          options={licences.map((licence) => ({
            value: licence.licenseId,
            label: licence.displayName,
          }))}
          selected={controls.allowedLicenseIds}
          onToggle={(value) => toggleIn('allowedLicenseIds', value)}
          empty={t('appsInference.form.licensing.empty')}
        />
      </FormSection>

      <FormSection
        title={t('appsInference.form.price.title')}
        description={t('appsInference.form.price.description')}
      >
        <View className="max-w-40">
          <TextInputField
            label={t('appsInference.form.price.currency')}
            value={currency}
            onChange={(value) => setCurrency(value.toUpperCase())}
            placeholder="USD"
            maxLength={3}
          />
        </View>

        <View className="max-w-60">
          <TextInputField
            label={t('appsInference.form.price.perRequest')}
            value={perRequest}
            onChange={setPerRequest}
            placeholder={t('appsInference.form.price.noCeiling')}
            inputMode="decimal"
          />
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">
            {t('appsInference.form.price.perUnit')}
          </Text>
          {perUnit.length === 0 ? (
            <MutedText>{t('appsInference.form.price.noPerUnit')}</MutedText>
          ) : (
            <View className="gap-3">
              {perUnit.map((draft, index) => (
                <View key={draft.unit} className="flex-row flex-wrap items-end gap-2">
                  <View className="w-44 gap-1">
                    <MutedText small>{t('appsInference.form.price.unit')}</MutedText>
                    <Text className="text-sm text-foreground">{USAGE_UNIT_LABELS[draft.unit]}</Text>
                  </View>
                  <View className="w-40">
                    <TextInputField
                      label={t('appsInference.form.price.amount')}
                      value={draft.amount}
                      inputMode="decimal"
                      onChange={(value) => updateDraft(index, { amount: value })}
                    />
                  </View>
                  <View className="w-28">
                    <TextInputField
                      label={t('appsInference.form.price.per')}
                      value={draft.per}
                      inputMode="numeric"
                      onChange={(value) => updateDraft(index, { per: value })}
                    />
                  </View>
                  <Button
                    appearance="plain"
                    size="sm"
                    iconOnly
                    icon={RiCloseLine}
                    accessibilityLabel={t('appsInference.form.price.remove', {
                      unit: USAGE_UNIT_LABELS[draft.unit],
                    })}
                    onPress={() =>
                      setPerUnit((current) => current.filter((_, position) => position !== index))
                    }
                  />
                </View>
              ))}
            </View>
          )}

          {unusedUnits.length > 0 && (
            <View className="max-w-64">
              <SelectField
                label={t('appsInference.form.price.addPerUnit')}
                value=""
                placeholder={t('appsInference.form.price.addPerUnit')}
                items={unusedUnits.map((unit) => ({ value: unit, label: USAGE_UNIT_LABELS[unit] }))}
                onChange={(unit) =>
                  setPerUnit((current) => [...current, { unit, amount: '', per: '1000000' }])
                }
              />
            </View>
          )}
        </View>
      </FormSection>

      <FormSection
        title={t('appsInference.form.fallback.title')}
        description={t('appsInference.form.fallback.description')}
      >
        <ToggleRow
          label={t('appsInference.form.fallback.disabled.label')}
          description={t('appsInference.form.fallback.disabled.description')}
          checked={controls.fallback.disabled}
          onCheckedChange={setFallbackDisabled}
        />
        <ToggleRow
          label={t('appsInference.form.fallback.sameModel.label')}
          description={t('appsInference.form.fallback.sameModel.description')}
          checked={controls.fallback.sameModelDeployment ?? !controls.fallback.disabled}
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
            label={t('appsInference.form.fallback.crossModel')}
            options={modelReferences.map((reference) => ({ value: reference, label: reference }))}
            selected={controls.fallback.authorizedCrossModel}
            onToggle={toggleCrossModel}
            empty={t('appsInference.form.fallback.crossModelEmpty')}
          />
        )}
      </FormSection>

      <View className="flex-row items-center gap-2">
        <Button onPress={handleSubmit} disabled={isPending} loading={isPending}>
          {submitLabel}
        </Button>
        <Button appearance="outline" onPress={onCancel} disabled={isPending}>
          {t('common.cancel')}
        </Button>
      </View>
    </View>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-4">
      <View>
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
        <Text className="text-sm text-muted-foreground">{description}</Text>
      </View>
      {children}
    </View>
  );
}

function EmptyControl({ children }: { children: ReactNode }) {
  return (
    <View className="rounded-lg border border-border bg-muted p-3">
      <Text className="text-sm text-muted-foreground">{children}</Text>
    </View>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      <Switch
        checked={checked}
        disabled={disabled}
        accessibilityLabel={label}
        onCheckedChange={onCheckedChange}
      />
    </View>
  );
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
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: ReadonlyArray<string>;
  onToggle: (value: string) => void;
  empty: string;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      {options.length === 0 ? (
        <MutedText>{empty}</MutedText>
      ) : (
        <View className="flex-row flex-wrap gap-1.5">
          {options.map((option) => {
            const isSelected = selected.includes(option.value);
            return (
              <Chip
                key={option.value}
                size="sm"
                checked={isSelected}
                variant={isSelected ? 'solid' : 'outlined'}
                trailingIcon={isSelected ? RiCloseLine : RiAddLine}
                onPress={() => onToggle(option.value)}
              >
                {option.label}
              </Chip>
            );
          })}
        </View>
      )}
    </View>
  );
}

/**
 * The allowed-list checkboxes, over options DERIVED from
 * `GET /models/routing-profiles` (plus any id the stored policy already names,
 * so a save never silently drops it).
 */
function ProfileCheckboxGroup({
  label,
  options,
  selected,
  onToggle,
  unlistedNote,
}: {
  label: string;
  options: ReadonlyArray<RoutingProfileOption>;
  selected: ReadonlyArray<string>;
  onToggle: (routingProfileId: string) => void;
  unlistedNote: string;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <View className="gap-2">
        {options.map((option) => (
          <Checkbox
            key={option.routingProfileId}
            nativeID={`routing-allowed-${option.routingProfileId}`}
            checked={selected.includes(option.routingProfileId)}
            onCheckedChange={() => onToggle(option.routingProfileId)}
            label={`${option.label} (${option.routingProfileId})`}
            description={option.listed ? option.description : unlistedNote}
          />
        ))}
      </View>
    </View>
  );
}
