import { Badge } from '@oxy.so/bloom/badge';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import type { RoutingProfile } from '@oxy.so/contracts';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import { useRoutingProfiles } from '@/hooks/use-models';
import { useTranslation } from '@/lib/i18n';
import { BadgeRow } from './BadgeRow';
import { LoadFailed } from './LoadFailed';

/** Routing profiles: policy objects with their own id space, never models (ADR 0008). */
export function RoutingProfilesTab() {
  const { t } = useTranslation();
  const { data: profiles, isLoading, isError } = useRoutingProfiles();

  const columns = useMemo<Array<DataTableColumn<RoutingProfile>>>(
    () => [
      {
        id: 'profile',
        header: t('modelsPage.columns.profile'),
        basis: 240,
        accessor: (profile) => profile.displayName,
        cell: ({ row }) => (
          <View className="gap-0.5">
            <View className="flex-row items-center gap-2">
              <Text className="text-sm font-medium text-foreground">{row.displayName}</Text>
              {row.isProductPreset && (
                <Badge
                  size="label-small"
                  variant="subtle"
                  content={t('modelsPage.profiles.productPreset')}
                />
              )}
            </View>
            <Text selectable className="font-mono text-xs text-muted-foreground">
              {row.slug}
            </Text>
            {row.description !== undefined && (
              <Text className="text-xs text-muted-foreground">{row.description}</Text>
            )}
          </View>
        ),
      },
      {
        id: 'optimises',
        header: t('modelsPage.columns.optimises'),
        basis: 160,
        accessor: (profile) => profile.optimiseFor,
        cell: ({ row }) => (
          <Badge
            size="label-small"
            variant="outlined"
            content={t('modelsPage.profiles.optimises', { goal: row.optimiseFor })}
          />
        ),
      },
      {
        id: 'candidates',
        header: t('modelsPage.profiles.candidates'),
        basis: 320,
        cell: ({ row }) => (
          <BadgeRow
            items={[...row.candidates]
              .sort((left, right) => left.priority - right.priority)
              .map((candidate) => candidate.modelReference)}
          />
        ),
      },
    ],
    [t],
  );

  if (isLoading) return <Skeleton.Box width="100%" height={240} />;
  if (isError) return <LoadFailed what={t('modelsPage.loadFailed.profiles')} />;

  return (
    <DataTable
      rows={profiles ?? []}
      columns={columns}
      getRowId={(profile) => profile.routingProfileId}
      accessibilityLabel={t('modelsPage.tabs.profiles')}
      pageSize={12}
      minWidth={720}
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
