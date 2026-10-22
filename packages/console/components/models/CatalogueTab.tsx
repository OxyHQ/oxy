import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCpuLine } from '@oxy.so/bloom/icons/RiCpuLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import type { ModelCatalogueEntry } from '@oxy.so/contracts';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { useModelCatalogue } from '@/hooks/use-models';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import {
  EMPTY_CATALOGUE_FILTERS,
  catalogueFacets,
  filterCatalogue,
} from '@/lib/model-catalogue-filters';
import { CatalogueEntryDetail } from './CatalogueEntryDetail';
import { CatalogueFilterBar } from './CatalogueFilterBar';
import { LoadFailed } from './LoadFailed';

/**
 * The catalogue tab, rendered from the real catalogue.
 *
 * Nothing here is fabricated. An empty catalogue renders as an empty state that
 * says so: not a spinner, not a placeholder row, and not the retired `alia-*` tiers.
 */
export function CatalogueTab() {
  const { t } = useTranslation();
  const { data: entries, isLoading, isError } = useModelCatalogue();
  const [filters, setFilters] = useState(EMPTY_CATALOGUE_FILTERS);
  const [opened, setOpened] = useState<ModelCatalogueEntry | null>(null);

  const catalogue = useMemo(() => entries ?? [], [entries]);
  const facets = useMemo(() => catalogueFacets(catalogue), [catalogue]);
  const visible = useMemo(() => filterCatalogue(catalogue, filters), [catalogue, filters]);

  const columns = useMemo<Array<DataTableColumn<ModelCatalogueEntry>>>(
    () => [
      {
        id: 'model',
        header: t('modelsPage.columns.model'),
        basis: 240,
        accessor: (entry) => entry.displayName,
        cell: ({ row }) => (
          <View className="gap-0.5">
            <View className="flex-row items-center gap-2">
              <Text className="text-sm font-medium text-foreground">{row.displayName}</Text>
              {row.deprecation.status !== 'active' && (
                <Badge size="label-small" variant="subtle" content={row.deprecation.status} />
              )}
            </View>
            <Text selectable className="font-mono text-xs text-muted-foreground">
              {row.modelId}
            </Text>
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
        basis: 140,
        accessor: (entry) => entry.capabilities.maxContextTokens,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground">
            {t('modelsPage.entry.tokens', {
              count: row.capabilities.maxContextTokens.toLocaleString(),
            })}
          </Text>
        ),
      },
      {
        id: 'modalities',
        header: t('modelsPage.columns.modalities'),
        basis: 180,
        cell: ({ row }) => (
          <Text className="text-sm text-muted-foreground">
            {`${row.capabilities.inputModalities.join(', ')} → ${row.capabilities.outputModalities.join(', ')}`}
          </Text>
        ),
      },
      {
        id: 'details',
        header: '',
        headerAccessibilityLabel: t('modelsPage.columns.details'),
        basis: 100,
        cell: ({ row }) => (
          <Button appearance="plain" tone="accent" size="sm" onPress={() => setOpened(row)}>
            {t('modelsPage.columns.details')}
          </Button>
        ),
      },
    ],
    [t],
  );

  if (isLoading) return <Skeleton.Box width="100%" height={240} />;
  if (isError) return <LoadFailed what={t('modelsPage.loadFailed.catalogue')} />;

  if (catalogue.length === 0) {
    return (
      <View className="items-center gap-6 py-12">
        <EmptyState
          icon={RiCpuLine}
          title={t('modelsPage.empty.title')}
          description={t('modelsPage.empty.body')}
          footer={
            <Button
              appearance="plain"
              tone="accent"
              size="sm"
              href={config.docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('modelsPage.empty.docsLink')}
            </Button>
          }
        />
        <View className="w-full max-w-lg">
          {/* The question an empty catalogue raises is "so can I call anything?", and
              the answer already exists as one component. Reused so the two cannot drift. */}
          <InferenceAvailabilityNotice />
        </View>
      </View>
    );
  }

  return (
    <View>
      <CatalogueFilterBar
        facets={facets}
        filters={filters}
        onChange={setFilters}
        total={catalogue.length}
        shown={visible.length}
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowId={(entry) => entry.modelId}
        accessibilityLabel={t('modelsPage.title')}
        pageSize={12}
        minWidth={760}
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

      {opened !== null && (
        <Dialog
          open
          onClose={() => setOpened(null)}
          placement={{ base: 'bottom', md: 'center' }}
          title={opened.displayName}
          description={t('modelsPage.entry.publishedBy', { name: opened.publisher.displayName })}
          actions={[{ label: t('common.close'), color: 'cancel' }]}
        >
          <CatalogueEntryDetail entry={opened} />
        </Dialog>
      )}
    </View>
  );
}
