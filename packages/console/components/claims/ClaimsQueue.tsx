import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { ContentClaimListResponse } from '@oxy.so/contracts';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { useContentClaims } from '@/hooks/use-content-claims';
import {
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_STATES,
  type ContentClaimFilters,
  EMPTY_CLAIM_FILTERS,
  toggleFilterValue,
} from '@/lib/content-claims';
import { useTranslation } from '@/lib/i18n';
import { ClaimDeadlineBadge, ClaimStateBadge } from './ClaimBadges';

type ClaimRow = ContentClaimListResponse['claims'][number];

const DEADLINE_FILTERS = ['overdue', 'due_soon', 'any'] as const;

/** Open claims are what a reviewer works through; the filter starts there. */
const INITIAL_FILTERS: ContentClaimFilters = {
  ...EMPTY_CLAIM_FILTERS,
  states: ['received', 'reviewing', 'actioned', 'counter_noticed'],
};

/**
 * The content-claim queue (ADR 0043 D10), newest first. The deadline filters list only
 * open erasure requests, soonest due first: the order the API returns, never re-sorted
 * here. The server pages on its own cursor, so "Load more" extends the table.
 */
export function ClaimsQueue() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<ContentClaimFilters>(INITIAL_FILTERS);
  const query = useContentClaims(filters);
  const claims = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.claims),
    [query.data],
  );

  const columns = useMemo<Array<DataTableColumn<ClaimRow>>>(
    () => [
      {
        id: 'reference',
        header: t('claimsPage.columns.reference'),
        basis: 170,
        cell: ({ row }) => (
          <Button appearance="plain" tone="accent" size="sm" href={`/claims/${row.id}`}>
            {row.reference}
          </Button>
        ),
      },
      {
        id: 'kind',
        header: t('claimsPage.columns.kind'),
        basis: 130,
        cell: ({ row }) => <Text>{t(`claimsPage.kinds.${row.kind}`)}</Text>,
      },
      {
        id: 'state',
        header: t('claimsPage.columns.state'),
        basis: 140,
        cell: ({ row }) => <ClaimStateBadge state={row.state} />,
      },
      {
        id: 'received',
        header: t('claimsPage.columns.received'),
        basis: 180,
        accessor: (row) => new Date(row.receivedAt),
        cell: ({ row }) => <Muted>{new Date(row.receivedAt).toLocaleString()}</Muted>,
      },
      {
        id: 'deadline',
        header: t('claimsPage.columns.deadline'),
        basis: 160,
        cell: ({ row }) => <ClaimDeadlineBadge claim={row} />,
      },
      {
        id: 'blocked',
        header: t('claimsPage.columns.blocked'),
        basis: 100,
        cell: ({ row }) => (
          <Muted>
            {t('claimsPage.blockedOf', { blocked: row.blockedTargetCount, total: row.targetCount })}
          </Muted>
        ),
      },
    ],
    [t],
  );

  return (
    <View className="gap-4">
      <View className="gap-3">
        <View className="gap-1">
          <Muted className="text-xs">{t('claimsPage.filters.state')}</Muted>
          <ChipRow accessibilityLabel={t('claimsPage.filters.state')}>
            {CONTENT_CLAIM_STATES.map((state) => (
              <Chip
                key={state}
                size="sm"
                role="checkbox"
                selected={filters.states.includes(state)}
                onPress={() =>
                  setFilters((current) => ({
                    ...current,
                    states: toggleFilterValue(current.states, state),
                  }))
                }
              >
                {t(`claimsPage.states.${state}`)}
              </Chip>
            ))}
          </ChipRow>
        </View>
        <View className="gap-1">
          <Muted className="text-xs">{t('claimsPage.filters.kind')}</Muted>
          <ChipRow accessibilityLabel={t('claimsPage.filters.kind')}>
            {CONTENT_CLAIM_KINDS.map((kind) => (
              <Chip
                key={kind}
                size="sm"
                role="checkbox"
                selected={filters.kinds.includes(kind)}
                onPress={() =>
                  setFilters((current) => ({
                    ...current,
                    kinds: toggleFilterValue(current.kinds, kind),
                  }))
                }
              >
                {t(`claimsPage.kinds.${kind}`)}
              </Chip>
            ))}
          </ChipRow>
        </View>
        <View className="gap-1">
          <Muted className="text-xs">{t('claimsPage.filters.deadline')}</Muted>
          <ChipRow accessibilityLabel={t('claimsPage.filters.deadline')}>
            {DEADLINE_FILTERS.map((option) => (
              <Chip
                key={option}
                size="sm"
                role="checkbox"
                selected={filters.deadline === option}
                onPress={() =>
                  setFilters((current) => ({
                    ...current,
                    deadline: current.deadline === option ? null : option,
                  }))
                }
              >
                {t(`claimsPage.deadlines.${option}`)}
              </Chip>
            ))}
          </ChipRow>
        </View>
      </View>

      {query.isLoading ? (
        <TableSkeleton columns={6} />
      ) : query.isError ? (
        <ApiState error={query.error} onRetry={query.refetch} />
      ) : (
        <DataTable
          layout="inset"
          rows={claims}
          columns={columns}
          getRowId={(row) => row.id}
          accessibilityLabel={t('claimsPage.title')}
          title={t('claimsPage.title')}
          summary={t('claimsPage.count', { count: claims.length })}
          pageSize={50}
          minWidth={860}
          emptyState={<EmptyState variant="compact" title={t('claimsPage.empty')} />}
        />
      )}

      {query.hasNextPage && (
        <View className="items-start">
          <Button
            appearance="outline"
            size="sm"
            onPress={() => void query.fetchNextPage()}
            loading={query.isFetchingNextPage}
          >
            {t('claimsPage.loadMore')}
          </Button>
        </View>
      )}
    </View>
  );
}
