import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import type { InferenceModality, InferenceOutputModality } from '@oxy.so/contracts';
import { Text, View } from 'react-native';

import { OptionSelect } from '@/components/content/OptionSelect';
import { useTranslation } from '@/lib/i18n';
import {
  type CatalogueFacets,
  type CatalogueFilters,
  PRICE_CAP_PER,
  isEmptyFilterSet,
} from '@/lib/model-catalogue-filters';

const ANY = '__any__';

interface CatalogueFilterBarProps {
  facets: CatalogueFacets;
  filters: CatalogueFilters;
  onChange: (next: CatalogueFilters) => void;
  total: number;
  shown: number;
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} accessibilityLabel={label} />
      <Text className="text-sm text-foreground">{label}</Text>
    </View>
  );
}

/**
 * The filter bar, with options derived from the loaded catalogue.
 *
 * Every control here is shown only when the loaded catalogue could actually be
 * narrowed by it: a select needs more than one value to choose between, and the
 * price cap needs at least one published input-token price. So the bar never
 * offers a filter whose every setting returns the same list.
 */
export function CatalogueFilterBar({
  facets,
  filters,
  onChange,
  total,
  shown,
}: CatalogueFilterBarProps) {
  const { t } = useTranslation();

  const withAny = (anyLabel: string, values: ReadonlyArray<{ value: string; label: string }>) => [
    { value: ANY, label: anyLabel },
    ...values,
  ];
  const plain = (values: ReadonlyArray<string>) => values.map((value) => ({ value, label: value }));

  return (
    <View className="mb-6 gap-4">
      <View className="flex-row flex-wrap items-end gap-3">
        <View className="min-w-56 flex-1">
          <TextFieldInput
            label={t('modelsPage.filters.search')}
            value={filters.query}
            onChangeText={(query) => onChange({ ...filters, query })}
            placeholder={t('modelsPage.filters.searchPlaceholder')}
          />
        </View>

        {facets.inputModalities.length > 1 && (
          <OptionSelect
            className="w-44"
            label={t('modelsPage.filters.inputModality')}
            value={filters.inputModality ?? ANY}
            options={withAny(t('modelsPage.filters.anyModality'), plain(facets.inputModalities))}
            onChange={(value) =>
              onChange({
                ...filters,
                inputModality: value === ANY ? null : (value as InferenceModality),
              })
            }
          />
        )}

        {facets.outputModalities.length > 1 && (
          <OptionSelect
            className="w-44"
            label={t('modelsPage.filters.outputModality')}
            value={filters.outputModality ?? ANY}
            options={withAny(t('modelsPage.filters.anyModality'), plain(facets.outputModalities))}
            onChange={(value) =>
              onChange({
                ...filters,
                outputModality: value === ANY ? null : (value as InferenceOutputModality),
              })
            }
          />
        )}

        {facets.regions.length > 1 && (
          <OptionSelect
            className="w-44"
            label={t('modelsPage.filters.region')}
            value={filters.region ?? ANY}
            options={withAny(t('modelsPage.filters.anyRegion'), plain(facets.regions))}
            onChange={(value) => onChange({ ...filters, region: value === ANY ? null : value })}
          />
        )}

        {facets.providers.length > 1 && (
          <OptionSelect
            className="w-52"
            label={t('modelsPage.filters.provider')}
            value={filters.provider ?? ANY}
            options={withAny(
              t('modelsPage.filters.anyProvider'),
              facets.providers.map((provider) => ({
                value: provider.slug,
                label: provider.displayName,
              })),
            )}
            onChange={(value) => onChange({ ...filters, provider: value === ANY ? null : value })}
          />
        )}

        {/* A text input rather than a number input: the value is an exact decimal
            compared against the ledger's own exact decimals, and a number input
            hands back a value that has been through a float. `inputMode` still gets
            the numeric keypad on a phone without that cost. */}
        {facets.hasInputTokenPricing && (
          <View className="w-52">
            <TextFieldInput
              label={t('modelsPage.filters.maxPrice', { per: PRICE_CAP_PER.toLocaleString() })}
              inputMode="decimal"
              value={filters.maxPricePerMillionInputTokens ?? ''}
              onChangeText={(value) =>
                onChange({
                  ...filters,
                  maxPricePerMillionInputTokens: value === '' ? null : value,
                })
              }
              placeholder="3.00"
            />
          </View>
        )}
      </View>

      <View className="flex-row flex-wrap items-center gap-x-6 gap-y-3">
        <ToggleRow
          label={t('modelsPage.filters.supportsTools')}
          checked={filters.toolsOnly}
          onChange={(toolsOnly) => onChange({ ...filters, toolsOnly })}
        />
        <ToggleRow
          label={t('modelsPage.filters.zeroRetention')}
          checked={filters.zeroRetentionOnly}
          onChange={(zeroRetentionOnly) => onChange({ ...filters, zeroRetentionOnly })}
        />
        <ToggleRow
          label={t('modelsPage.filters.noTraining')}
          checked={filters.noTrainingOnly}
          onChange={(noTrainingOnly) => onChange({ ...filters, noTrainingOnly })}
        />

        <Text className="ml-auto text-xs text-muted-foreground">
          {isEmptyFilterSet(filters)
            ? t('modelsPage.filters.count', { count: total })
            : t('modelsPage.filters.shownOfTotal', { shown, total })}
        </Text>
      </View>
    </View>
  );
}
