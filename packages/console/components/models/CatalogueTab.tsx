import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCpuLine } from '@oxy.so/bloom/icons/RiCpuLine';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { LoadingRows } from '@/components/content/LoadingRows';
import { TextLink } from '@/components/content/TextLink';
import { useModelCatalogue } from '@/hooks/use-models';
import { useTranslation } from '@/lib/i18n';
import {
  EMPTY_CATALOGUE_FILTERS,
  catalogueFacets,
  filterCatalogue,
} from '@/lib/model-catalogue-filters';
import { CatalogueEntryRow } from './CatalogueEntryRow';
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

  const catalogue = useMemo(() => entries ?? [], [entries]);
  const facets = useMemo(() => catalogueFacets(catalogue), [catalogue]);
  const visible = useMemo(() => filterCatalogue(catalogue, filters), [catalogue, filters]);

  if (isLoading) return <LoadingRows />;
  if (isError) return <LoadFailed what={t('modelsPage.loadFailed.catalogue')} />;

  if (catalogue.length === 0) {
    return (
      <View className="items-center gap-6 py-12">
        <EmptyState
          icon={RiCpuLine}
          title={t('modelsPage.empty.title')}
          description={t('modelsPage.empty.body')}
        />
        <View className="w-full max-w-lg gap-4">
          {/* The question an empty catalogue raises is "so can I call anything?", and
              the answer already exists as one component. Reused so the two cannot drift. */}
          <InferenceAvailabilityNotice />
          <TextLink href="/documentation/models">{t('modelsPage.empty.docsLink')}</TextLink>
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

      {visible.length === 0 ? (
        <EmptyState
          title={t('modelsPage.noMatch.title')}
          action={{
            label: t('modelsPage.noMatch.clear'),
            onPress: () => setFilters(EMPTY_CATALOGUE_FILTERS),
          }}
        />
      ) : (
        <View>
          {visible.map((entry, index) => (
            <CatalogueEntryRow
              key={entry.modelId}
              entry={entry}
              isLast={index === visible.length - 1}
            />
          ))}
        </View>
      )}
    </View>
  );
}
