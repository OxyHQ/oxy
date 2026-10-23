import { useState } from 'react';
import { Text, View } from 'react-native';
import { USAGE_UNITS, currencyCodeSchema, exactDecimalSchema } from '@oxy.so/contracts';
import type { ModelCatalogueEntry, RoutingProfile, UnitPrice, UsageUnit } from '@oxy.so/contracts';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Chip } from '@oxy.so/bloom/chip';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
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

  const optionLabel = (items: ReadonlyArray<{ value: string; label: string }>, value: string) =>
    items.find((item) => item.value === value)?.label ?? value;

  /** One option row of a Bloom Select. */
  const renderOption = (item: { value: string; label: string; disabled?: boolean }) => (
    <SelectItem value={item.value} label={item.label} disabled={item.disabled}>
      <SelectItemIndicator />
      <SelectItemText>{item.label}</SelectItemText>
    </SelectItem>
  );

  const toggle = (
    title: string,
    description: string,
    checked: boolean,
    onCheckedChange: (checked: boolean) => void,
    disabled?: boolean,
  ) => (
    <GroupedSectionItem
      title={title}
      titleNumberOfLines={0}
      description={description}
      disabled={disabled}
      rightElement={
        <Switch
          checked={checked}
          disabled={disabled}
          accessibilityLabel={title}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );

  return (
    <View className="gap-8">
      {errors.length > 0 && (
        <Admonition type="error">
          <Text className="font-semibold">{t('appsInference.form.errors.title')}</Text>
          {errors.map((problem) => `\n• ${problem}`).join('')}
        </Admonition>
      )}

      <GroupedSection
        title={t('appsInference.form.power.title')}
        footer={t('appsInference.form.power.description')}
        separator="none"
      >
        <View className="gap-4 p-4">
          {powerLevelOptions.length === 0 && otherProfileOptions.length === 0 ? (
            <Admonition type="info">{t('appsInference.form.power.empty')}</Admonition>
          ) : (
            <>
              <Text className="text-xs text-muted-foreground">
                {controls.allowedRoutingProfileIds.length === 0
                  ? t('appsInference.form.power.unrestricted')
                  : t('appsInference.form.power.restricted')}
              </Text>
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
        </View>
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.default.title')}
        footer={t('appsInference.form.default.description')}
        separator="none"
      >
        <View className="p-4">
          {modelReferences.length === 0 && profileOptions.length === 0 ? (
            <Admonition type="info">{t('appsInference.form.default.empty')}</Admonition>
          ) : (
            <Field
              label={t('appsInference.form.default.label')}
              error={defaultOutsideAllowed ? t('appsInference.form.default.outsideAllowed') : null}
            >
              <Select value={defaultTargetValue} onValueChange={setDefaultTarget}>
                <SelectTrigger>
                  <SelectValue>
                    {() => optionLabel(defaultTargetItems, defaultTargetValue)}
                  </SelectValue>
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent
                  label={t('appsInference.form.default.label')}
                  items={defaultTargetItems}
                  renderItem={renderOption}
                />
              </Select>
            </Field>
          )}
        </View>
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.providers.title')}
        footer={t('appsInference.form.providers.description')}
        separator="none"
      >
        <View className="gap-4 p-4">
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
        </View>
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.regions.title')}
        footer={t('appsInference.form.regions.description')}
        separator="none"
      >
        <View className="gap-4 p-4">
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
        </View>
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.data.title')}
        footer={t('appsInference.form.data.description')}
      >
        {toggle(
          t('appsInference.form.data.zeroRetention.label'),
          t('appsInference.form.data.zeroRetention.description'),
          controls.requireZeroDataRetention,
          (checked) => patch({ requireZeroDataRetention: checked }),
        )}
        {toggle(
          t('appsInference.form.data.noTraining.label'),
          t('appsInference.form.data.noTraining.description'),
          controls.prohibitTrainingOnCustomerData,
          (checked) => patch({ prohibitTrainingOnCustomerData: checked }),
        )}
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.selection.title')}
        footer={t('appsInference.form.selection.description')}
      >
        <View className="gap-4 p-4">
          <Field label={t('appsInference.form.selection.optimiseFor')}>
            <Select
              value={controls.optimiseFor}
              onValueChange={(next) =>
                patch({ optimiseFor: next as RoutingPolicyControls['optimiseFor'] })
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {() => optionLabel(OPTIMISE_FOR_OPTIONS, controls.optimiseFor)}
                </SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsInference.form.selection.optimiseFor')}
                items={OPTIMISE_FOR_OPTIONS}
                renderItem={renderOption}
              />
            </Select>
          </Field>
          <Field label={t('appsInference.form.selection.capacity')}>
            <Select
              value={controls.dedicatedCapacity}
              onValueChange={(next) =>
                patch({ dedicatedCapacity: next as RoutingPolicyControls['dedicatedCapacity'] })
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {() => optionLabel(DEDICATED_CAPACITY_OPTIONS, controls.dedicatedCapacity)}
                </SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsInference.form.selection.capacity')}
                items={DEDICATED_CAPACITY_OPTIONS}
                renderItem={renderOption}
              />
            </Select>
          </Field>
          <Field label={t('appsInference.form.selection.byok')}>
            <Select
              value={controls.byokPreference}
              onValueChange={(next) =>
                patch({ byokPreference: next as RoutingPolicyControls['byokPreference'] })
              }
            >
              <SelectTrigger>
                <SelectValue>
                  {() => optionLabel(BYOK_PREFERENCE_OPTIONS, controls.byokPreference)}
                </SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectContent
                label={t('appsInference.form.selection.byok')}
                items={BYOK_PREFERENCE_OPTIONS}
                renderItem={renderOption}
              />
            </Select>
          </Field>
        </View>
        {toggle(
          t('appsInference.form.selection.hostedOnly.label'),
          t('appsInference.form.selection.hostedOnly.description'),
          controls.oxyHostedOnly,
          (checked) => patch({ oxyHostedOnly: checked }),
        )}
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.licensing.title')}
        footer={t('appsInference.form.licensing.description')}
      >
        {toggle(
          t('appsInference.form.licensing.commercial.label'),
          t('appsInference.form.licensing.commercial.description'),
          controls.requireCommercialUseRights,
          (checked) => patch({ requireCommercialUseRights: checked }),
        )}
        <View className="p-4">
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
        </View>
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.price.title')}
        footer={t('appsInference.form.price.description')}
        separator="none"
      >
        <View className="gap-4 p-4">
          <View className="max-w-40">
            <Field label={t('appsInference.form.price.currency')}>
              <TextFieldInput
                label={t('appsInference.form.price.currency')}
                value={currency}
                onValueChange={(value) => setCurrency(value.toUpperCase())}
                placeholder="USD"
                maxLength={3}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            </Field>
          </View>

          <View className="max-w-60">
            <Field label={t('appsInference.form.price.perRequest')}>
              <TextFieldInput
                label={t('appsInference.form.price.perRequest')}
                value={perRequest}
                onValueChange={setPerRequest}
                placeholder={t('appsInference.form.price.noCeiling')}
                inputMode="decimal"
              />
            </Field>
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">
              {t('appsInference.form.price.perUnit')}
            </Text>
            {perUnit.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t('appsInference.form.price.noPerUnit')}
              </Text>
            ) : (
              <View className="gap-3">
                {perUnit.map((draft, index) => (
                  <View key={draft.unit} className="flex-row flex-wrap items-end gap-2">
                    <View className="w-44">
                      <Field label={t('appsInference.form.price.unit')}>
                        <Text className="py-2 text-sm text-foreground">
                          {USAGE_UNIT_LABELS[draft.unit]}
                        </Text>
                      </Field>
                    </View>
                    <View className="w-40">
                      <Field label={t('appsInference.form.price.amount')}>
                        <TextFieldInput
                          label={t('appsInference.form.price.amount')}
                          value={draft.amount}
                          inputMode="decimal"
                          onValueChange={(value) => updateDraft(index, { amount: value })}
                        />
                      </Field>
                    </View>
                    <View className="w-28">
                      <Field label={t('appsInference.form.price.per')}>
                        <TextFieldInput
                          label={t('appsInference.form.price.per')}
                          value={draft.per}
                          inputMode="numeric"
                          onValueChange={(value) => updateDraft(index, { per: value })}
                        />
                      </Field>
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
                <Field label={t('appsInference.form.price.addPerUnit')}>
                  <Select
                    // Remounted per added unit so it returns to its placeholder: an empty
                    // string is a value to Bloom's Select and would draw a blank trigger.
                    key={perUnit.length}
                    onValueChange={(unit) =>
                      setPerUnit((current) => [
                        ...current,
                        { unit: unit as UsageUnit, amount: '', per: '1000000' },
                      ])
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('appsInference.form.price.addPerUnit')} />
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectContent
                      label={t('appsInference.form.price.addPerUnit')}
                      items={unusedUnits.map((unit) => ({
                        value: unit,
                        label: USAGE_UNIT_LABELS[unit],
                      }))}
                      renderItem={renderOption}
                    />
                  </Select>
                </Field>
              </View>
            )}
          </View>
        </View>
      </GroupedSection>

      <GroupedSection
        title={t('appsInference.form.fallback.title')}
        footer={t('appsInference.form.fallback.description')}
      >
        {toggle(
          t('appsInference.form.fallback.disabled.label'),
          t('appsInference.form.fallback.disabled.description'),
          controls.fallback.disabled,
          setFallbackDisabled,
        )}
        {toggle(
          t('appsInference.form.fallback.sameModel.label'),
          t('appsInference.form.fallback.sameModel.description'),
          controls.fallback.sameModelDeployment ?? !controls.fallback.disabled,
          (checked) =>
            setControls((current) => ({
              ...current,
              fallback: { ...current.fallback, sameModelDeployment: checked },
            })),
          controls.fallback.disabled,
        )}
        {!controls.fallback.disabled && (
          <View className="p-4">
            <TokenGroup
              label={t('appsInference.form.fallback.crossModel')}
              options={modelReferences.map((reference) => ({
                value: reference,
                label: reference,
              }))}
              selected={controls.fallback.authorizedCrossModel}
              onToggle={toggleCrossModel}
              empty={t('appsInference.form.fallback.crossModelEmpty')}
            />
          </View>
        )}
      </GroupedSection>

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
    <Field label={label} multiple>
      {options.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{empty}</Text>
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
    </Field>
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
    <Field label={label} multiple>
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
    </Field>
  );
}
