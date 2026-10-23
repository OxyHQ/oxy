import { Chip } from '@oxy.so/bloom/chip';
import {
  DataTable,
  DataTableFilter,
  type DataTableColumn,
  DataTableRowActions,
  DataTableSearch,
} from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCpuLine } from '@oxy.so/bloom/icons/RiCpuLine';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { ModelCatalogueEntry } from '@oxy.so/contracts';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { useModelCatalogue } from '@/hooks/use-models';
import { useTranslation } from '@/lib/i18n';
import {
  type CatalogueFilters,
  EMPTY_CATALOGUE_FILTERS,
  catalogueFacets,
  filterCatalogue,
  PRICE_CAP_PER,
} from '@/lib/model-catalogue-filters';
import { formatMoney } from '@/lib/money';
import { ModelDetailDialog } from './ModelDetailDialog';

const ANY = '__any__';
const CAPABILITIES = ['tools', 'zeroRetention', 'noTraining'] as const;
type Capability = (typeof CAPABILITIES)[number];
/** Caps offered by the price filter, per `PRICE_CAP_PER` input tokens. */
const PRICE_CAPS = ['1', '5', '20'] as const;

function activeCapability(filters: CatalogueFilters): Capability | typeof ANY {
  if (filters.toolsOnly) return 'tools';
  if (filters.zeroRetentionOnly) return 'zeroRetention';
  if (filters.noTrainingOnly) return 'noTraining';
  return ANY;
}

/** The catalogue as a table: search and filters in its toolbar, its row action opens the model's details. */
export function ModelCatalogue() {
  const { t } = useTranslation();
  const catalogue = useModelCatalogue();
  const [filters, setFilters] = useState(EMPTY_CATALOGUE_FILTERS);
  const [opened, setOpened] = useState<ModelCatalogueEntry | null>(null);

  const entries = useMemo(() => catalogue.data ?? [], [catalogue.data]);
  const facets = useMemo(() => catalogueFacets(entries), [entries]);
  const rows = useMemo(() => filterCatalogue(entries, filters), [entries, filters]);

  const columns = useMemo<Array<DataTableColumn<ModelCatalogueEntry>>>(
    () => [
      {
        id: 'model',
        header: t('modelsPage.columns.model'),
        basis: 260,
        accessor: (entry) => entry.displayName,
        cell: ({ row }) => (
          <View className="gap-0.5">
            <Text className="font-medium">{row.displayName}</Text>
            <Muted selectable className="font-mono text-xs">
              {row.modelId}
            </Muted>
          </View>
        ),
      },
      {
        id: 'publisher',
        header: t('modelsPage.columns.publisher'),
        basis: 140,
        accessor: (entry) => entry.publisher.displayName,
      },
      {
        id: 'context',
        header: t('modelsPage.entry.context'),
        basis: 130,
        accessor: (entry) => entry.capabilities.maxContextTokens,
        cell: ({ row }) => (
          <Text>
            {t('modelsPage.entry.tokens', {
              count: row.capabilities.maxContextTokens.toLocaleString(),
            })}
          </Text>
        ),
      },
      {
        id: 'capabilities',
        header: t('modelsPage.columns.capabilities'),
        basis: 220,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap gap-1">
            {row.capabilities.tools && <Chip size="sm">{t('modelsPage.capability.tools')}</Chip>}
            {row.capabilities.inputModalities.includes('image') && (
              <Chip size="sm">{t('modelsPage.capability.vision')}</Chip>
            )}
            {row.capabilities.reasoning && (
              <Chip size="sm">{t('modelsPage.capability.reasoning')}</Chip>
            )}
            {row.deprecation.status !== 'active' && (
              <Chip size="sm" color="warning">
                {row.deprecation.status}
              </Chip>
            )}
          </View>
        ),
      },
      {
        id: 'price',
        header: t('modelsPage.columns.price'),
        basis: 290,
        cell: ({ row }) => {
          const input = row.pricing?.unitPrices.find((price) => price.unit === 'input_tokens');
          return input === undefined ? (
            <Muted>{t('modelsPage.columns.noPrice')}</Muted>
          ) : (
            <Text>
              {t('modelsPage.entry.unitPrice', {
                amount: formatMoney(input.amount, input.currency),
                per: input.per.toLocaleString(),
                unit: input.unit.replace(/_/g, ' '),
              })}
            </Text>
          );
        },
      },
      {
        id: 'actions',
        header: '',
        headerAccessibilityLabel: t('modelsPage.columns.details'),
        width: 56,
        cell: ({ row }) => (
          <DataTableRowActions
            name={row.displayName}
            actions={[
              {
                icon: RiInformationLine,
                label: t('modelsPage.columns.details'),
                onPress: () => setOpened(row),
              },
            ]}
          />
        ),
      },
    ],
    [t],
  );

  if (catalogue.isLoading) return <TableSkeleton columns={5} />;
  if (catalogue.isError) return <ApiState error={catalogue.error} onRetry={catalogue.refetch} />;

  if (entries.length === 0) {
    return (
      <View className="gap-6">
        <EmptyState
          icon={RiCpuLine}
          title={t('modelsPage.empty.title')}
          description={t('modelsPage.empty.body')}
        />
        <InferenceAvailabilityNotice />
      </View>
    );
  }

  const anyOption = (label: string) => ({ value: ANY, label });

  return (
    <>
      <DataTable
        layout="inset"
        rows={rows}
        columns={columns}
        getRowId={(entry) => entry.modelId}
        accessibilityLabel={t('modelsPage.title')}
        title={t('modelsPage.tabs.models')}
        summary={t('modelsPage.filters.count', { count: rows.length })}
        pageSize={12}
        minWidth={1000}
        toolbar={
          <>
            <DataTableSearch
              label={t('modelsPage.filters.search')}
              placeholder={t('modelsPage.filters.searchPlaceholder')}
              value={filters.query}
              onValueChange={(query) => setFilters((current) => ({ ...current, query }))}
            />
            <DataTableFilter
              label={t('modelsPage.filters.provider')}
              value={filters.provider ?? ANY}
              onValueChange={(value) =>
                setFilters((current) => ({ ...current, provider: value === ANY ? null : value }))
              }
              options={[
                anyOption(t('modelsPage.filters.anyProvider')),
                ...facets.providers.map((provider) => ({
                  value: provider.slug,
                  label: provider.displayName,
                })),
              ]}
            />
            {facets.regions.length > 1 && (
              <DataTableFilter
                label={t('modelsPage.filters.region')}
                value={filters.region ?? ANY}
                onValueChange={(value) =>
                  setFilters((current) => ({ ...current, region: value === ANY ? null : value }))
                }
                options={[
                  anyOption(t('modelsPage.filters.anyRegion')),
                  ...facets.regions.map((value) => ({ value, label: value })),
                ]}
              />
            )}
            <DataTableFilter
              label={t('modelsPage.filters.inputModality')}
              value={filters.inputModality ?? ANY}
              onValueChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  inputModality:
                    facets.inputModalities.find((modality) => modality === value) ?? null,
                }))
              }
              options={[
                anyOption(t('modelsPage.filters.anyModality')),
                ...facets.inputModalities.map((value) => ({ value, label: value })),
              ]}
            />
            <DataTableFilter
              label={t('modelsPage.filters.outputModality')}
              value={filters.outputModality ?? ANY}
              onValueChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  outputModality:
                    facets.outputModalities.find((modality) => modality === value) ?? null,
                }))
              }
              options={[
                anyOption(t('modelsPage.filters.anyOutputModality')),
                ...facets.outputModalities.map((value) => ({ value, label: value })),
              ]}
            />
            <DataTableFilter
              label={t('modelsPage.filters.capability')}
              value={activeCapability(filters)}
              onValueChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  toolsOnly: value === 'tools',
                  zeroRetentionOnly: value === 'zeroRetention',
                  noTrainingOnly: value === 'noTraining',
                }))
              }
              options={[
                anyOption(t('modelsPage.filters.anyCapability')),
                ...CAPABILITIES.map((value) => ({
                  value,
                  label: t(`modelsPage.filters.capabilities.${value}`),
                })),
              ]}
            />
            {facets.hasInputTokenPricing && (
              <DataTableFilter
                label={t('modelsPage.filters.maxPrice', { per: PRICE_CAP_PER.toLocaleString() })}
                value={filters.maxPricePerMillionInputTokens ?? ANY}
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    maxPricePerMillionInputTokens: value === ANY ? null : value,
                  }))
                }
                options={[
                  anyOption(t('modelsPage.filters.anyPrice')),
                  ...PRICE_CAPS.map((value) => ({
                    value,
                    label: t('modelsPage.filters.priceUpTo', { amount: value }),
                  })),
                ]}
              />
            )}
          </>
        }
        emptyState={
          <EmptyState
            variant="compact"
            title={t('modelsPage.noMatch.title')}
            action={{
              label: t('modelsPage.noMatch.clear'),
              onPress: () => setFilters(EMPTY_CATALOGUE_FILTERS),
            }}
          />
        }
      />
      <ModelDetailDialog entry={opened} onClose={() => setOpened(null)} />
    </>
  );
}
