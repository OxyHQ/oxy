import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import type { ContentClaimListResponse } from '@oxy.so/contracts';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import {
  ClaimDeadlineBadge,
  ClaimStateBadge,
  ClaimsRefusal,
} from '@/components/claims/claim-badges';
import { useContentClaims, useContentClaimsAccess } from '@/hooks/use-content-claims';
import { isPermissionRefused } from '@/lib/api-error';
import {
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_STATES,
  type ContentClaimFilters,
  EMPTY_CLAIM_FILTERS,
  toggleFilterValue,
} from '@/lib/content-claims';
import { useTranslation } from '@/lib/i18n';

type ClaimRow = ContentClaimListResponse['claims'][number];

const DEADLINE_FILTERS = ['overdue', 'due_soon', 'any'] as const;

/** Open claims are what a reviewer works through; the filter starts there. */
const INITIAL_FILTERS: ContentClaimFilters = {
  ...EMPTY_CLAIM_FILTERS,
  states: ['received', 'reviewing', 'actioned', 'counter_noticed'],
};

/**
 * The content-claim queue (ADR 0043 D10): what people reported through oxy.so's
 * "Report content" page, for the staff who hold `content:claims`.
 *
 * Newest first; the deadline filters list only OPEN erasure requests, soonest due
 * first, the order the API returns and this page never re-sorts.
 */
export default function ContentClaimsQueueScreen() {
  const { t } = useTranslation();
  const access = useContentClaimsAccess();
  const [filters, setFilters] = useState<ContentClaimFilters>(INITIAL_FILTERS);
  const canReview = access.data?.canReview === true;
  const query = useContentClaims(filters, canReview);
  const claims = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.claims),
    [query.data],
  );

  const columns = useMemo<Array<DataTableColumn<ClaimRow>>>(
    () => [
      {
        id: 'reference',
        header: t('claimsPage.columns.reference'),
        basis: 160,
        cell: ({ row }) => (
          <Button appearance="plain" size="sm" href={`/claims/${row.id}`}>
            {row.reference}
          </Button>
        ),
      },
      {
        id: 'kind',
        header: t('claimsPage.columns.kind'),
        basis: 120,
        cell: ({ row }) => (
          <Text className="text-sm text-foreground">{t(`claimsPage.kinds.${row.kind}`)}</Text>
        ),
      },
      {
        id: 'state',
        header: t('claimsPage.columns.state'),
        basis: 130,
        cell: ({ row }) => <ClaimStateBadge state={row.state} />,
      },
      {
        id: 'received',
        header: t('claimsPage.columns.received'),
        basis: 170,
        cell: ({ row }) => (
          <Text className="text-sm text-muted-foreground">
            {new Date(row.receivedAt).toLocaleString()}
          </Text>
        ),
      },
      {
        id: 'deadline',
        header: t('claimsPage.columns.deadline'),
        basis: 150,
        cell: ({ row }) => <ClaimDeadlineBadge claim={row} />,
      },
      {
        id: 'blocked',
        header: t('claimsPage.columns.blocked'),
        basis: 100,
        cell: ({ row }) => (
          <Text className="text-sm text-muted-foreground">
            {t('claimsPage.blockedOf', { blocked: row.blockedTargetCount, total: row.targetCount })}
          </Text>
        ),
      },
    ],
    [t],
  );

  return (
    <Screen
      className="flex-1 bg-background"
      header={
        <PageHeader
          title={t('claimsPage.title')}
          subtitle={t('claimsPage.subtitle')}
          leading={<AppShellMenuButton />}
          presentation="bar"
          sticky={false}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-6">
        <View className="w-full max-w-6xl gap-6">
          {access.isLoading ? (
            <Skeleton.Box width="100%" height={64} />
          ) : !canReview || (query.isError && isPermissionRefused(query.error)) ? (
            <ClaimsRefusal />
          ) : (
            <View className="gap-4">
              <View className="gap-2">
                <View className="flex-row flex-wrap items-center gap-1.5">
                  <Text className="w-20 text-xs font-medium text-muted-foreground">
                    {t('claimsPage.filters.state')}
                  </Text>
                  {CONTENT_CLAIM_STATES.map((state) => (
                    <Chip
                      size="md"
                      role="checkbox"
                      key={state}
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
                </View>
                <View className="flex-row flex-wrap items-center gap-1.5">
                  <Text className="w-20 text-xs font-medium text-muted-foreground">
                    {t('claimsPage.filters.kind')}
                  </Text>
                  {CONTENT_CLAIM_KINDS.map((kind) => (
                    <Chip
                      size="md"
                      role="checkbox"
                      key={kind}
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
                </View>
                <View className="flex-row flex-wrap items-center gap-1.5">
                  <Text className="w-20 text-xs font-medium text-muted-foreground">
                    {t('claimsPage.filters.deadline')}
                  </Text>
                  {DEADLINE_FILTERS.map((option) => (
                    <Chip
                      size="md"
                      role="checkbox"
                      key={option}
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
                </View>
              </View>

              {query.isLoading ? (
                <View className="gap-2">
                  {[1, 2, 3].map((row) => (
                    <Skeleton.Box key={row} width="100%" height={44} />
                  ))}
                </View>
              ) : query.isError ? (
                <EmptyState variant="compact" description={t('claimsPage.loadFailed')} />
              ) : (
                <DataTable
                  rows={claims}
                  columns={columns}
                  getRowId={(row) => row.id}
                  accessibilityLabel={t('claimsPage.title')}
                  pageSize={50}
                  minWidth={820}
                  emptyState={<EmptyState variant="compact" description={t('claimsPage.empty')} />}
                />
              )}

              {query.hasNextPage && (
                <View className="items-start">
                  <Button
                    appearance="outline"
                    size="sm"
                    onPress={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                    loading={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage ? t('common.loading') : t('claimsPage.loadMore')}
                  </Button>
                </View>
              )}
            </View>
          )}
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
