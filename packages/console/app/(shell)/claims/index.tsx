import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import type { ContentClaimListResponse } from '@oxy.so/contracts';
import { type ReactNode, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import {
  ClaimDeadlineBadge,
  ClaimStateBadge,
  ClaimsRefusal,
} from '@/components/claims/claim-badges';
import { ContentScreen } from '@/components/content/ContentScreen';
import { TextLink } from '@/components/content/TextLink';
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

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      <Text className="w-20 text-xs font-medium text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}

function FilterChip({
  active,
  onPress,
  children,
}: {
  active: boolean;
  onPress: () => void;
  children: string;
}) {
  return (
    <Button size="xs" appearance={active ? 'subtle' : 'plain'} pressed={active} onPress={onPress}>
      {children}
    </Button>
  );
}

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
          <TextLink
            href={`/claims/${row.id}`}
            className="font-mono text-sm text-foreground underline"
          >
            {row.reference}
          </TextLink>
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
    <ContentScreen title={t('claimsPage.title')} subtitle={t('claimsPage.subtitle')} maxWidth="xl">
      {access.isLoading ? (
        <Skeleton.Box width="100%" height={64} />
      ) : !canReview || (query.isError && isPermissionRefused(query.error)) ? (
        <ClaimsRefusal />
      ) : (
        <View className="gap-4">
          <View className="gap-2">
            <FilterRow label={t('claimsPage.filters.state')}>
              {CONTENT_CLAIM_STATES.map((state) => (
                <FilterChip
                  key={state}
                  active={filters.states.includes(state)}
                  onPress={() =>
                    setFilters((current) => ({
                      ...current,
                      states: toggleFilterValue(current.states, state),
                    }))
                  }
                >
                  {t(`claimsPage.states.${state}`)}
                </FilterChip>
              ))}
            </FilterRow>
            <FilterRow label={t('claimsPage.filters.kind')}>
              {CONTENT_CLAIM_KINDS.map((kind) => (
                <FilterChip
                  key={kind}
                  active={filters.kinds.includes(kind)}
                  onPress={() =>
                    setFilters((current) => ({
                      ...current,
                      kinds: toggleFilterValue(current.kinds, kind),
                    }))
                  }
                >
                  {t(`claimsPage.kinds.${kind}`)}
                </FilterChip>
              ))}
            </FilterRow>
            <FilterRow label={t('claimsPage.filters.deadline')}>
              {DEADLINE_FILTERS.map((option) => (
                <FilterChip
                  key={option}
                  active={filters.deadline === option}
                  onPress={() =>
                    setFilters((current) => ({
                      ...current,
                      deadline: current.deadline === option ? null : option,
                    }))
                  }
                >
                  {t(`claimsPage.deadlines.${option}`)}
                </FilterChip>
              ))}
            </FilterRow>
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
    </ContentScreen>
  );
}
