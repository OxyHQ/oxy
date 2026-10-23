import { Chip } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { RoutingProfile } from '@oxy.so/contracts';
import { useMemo } from 'react';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { useRoutingProfiles } from '@/hooks/use-models';
import { useTranslation } from '@/lib/i18n';

/** Routing profiles: policy objects with their own id space, never models (ADR 0008). */
export function RoutingProfiles() {
  const { t } = useTranslation();
  const profiles = useRoutingProfiles();

  const columns = useMemo<Array<DataTableColumn<RoutingProfile>>>(
    () => [
      {
        id: 'profile',
        header: t('modelsPage.columns.profile'),
        basis: 260,
        accessor: (profile) => profile.displayName,
        cell: ({ row }) => (
          <View className="gap-0.5">
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="font-medium">{row.displayName}</Text>
              {row.isProductPreset && (
                <Chip size="sm">{t('modelsPage.profiles.productPreset')}</Chip>
              )}
            </View>
            <Muted selectable className="font-mono text-xs">
              {row.slug}
            </Muted>
            {row.description !== undefined && <Muted className="text-xs">{row.description}</Muted>}
          </View>
        ),
      },
      {
        id: 'optimises',
        header: t('modelsPage.columns.optimises'),
        basis: 160,
        accessor: (profile) => profile.optimiseFor,
        cell: ({ row }) => (
          <Chip size="sm">{t('modelsPage.profiles.optimises', { goal: row.optimiseFor })}</Chip>
        ),
      },
      {
        id: 'candidates',
        header: t('modelsPage.profiles.candidates'),
        basis: 340,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap gap-1">
            {[...row.candidates]
              .sort((left, right) => left.priority - right.priority)
              .map((candidate) => (
                <Chip key={candidate.modelReference} size="sm" hue="soft">
                  {candidate.modelReference}
                </Chip>
              ))}
          </View>
        ),
      },
    ],
    [t],
  );

  if (profiles.isLoading) return <TableSkeleton columns={3} />;
  if (profiles.isError) return <ApiState error={profiles.error} onRetry={profiles.refetch} />;

  return (
    <DataTable
      layout="inset"
      rows={profiles.data ?? []}
      columns={columns}
      getRowId={(profile) => profile.routingProfileId}
      accessibilityLabel={t('modelsPage.tabs.profiles')}
      title={t('modelsPage.tabs.profiles')}
      pageSize={12}
      minWidth={760}
      emptyState={
        <EmptyState
          variant="compact"
          title={t('modelsPage.profiles.emptyTitle')}
          description={t('modelsPage.profiles.emptyBody')}
        />
      }
    />
  );
}
