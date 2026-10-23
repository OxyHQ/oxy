import { Chip, type ChipHue } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn, DataTableRowActions } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiVipCrownLine } from '@oxy.so/bloom/icons/RiVipCrownLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';

import type { Subscription, useProductSubscriptions } from '@/hooks/use-billing';
import { useDateFormat } from '@/hooks/use-date-format';
import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';

type ProductSource = NonNullable<ReturnType<typeof useProductSubscriptions>['data']>[number];

export interface PendingCancel {
  kind: 'product' | 'credit';
  id: string;
  name: string;
}

interface SubscriptionRow {
  id: string;
  kind: PendingCancel['kind'];
  name: string;
  detail: string;
  status: string;
  periodEnd: string;
  cancelsAtPeriodEnd: boolean;
  canCancel: boolean;
}

const STATUS_HUE: Record<string, ChipHue> = {
  active: 'lime',
  trialing: 'cyan',
  past_due: 'yellow',
  unpaid: 'rose',
  canceled: 'gray',
};

/**
 * The signed-in user's named subscriptions: product access and API-credit plans.
 * Product and credit sources are listed together but never merged, and cancelling
 * either asks first (the parent owns the confirmation).
 */
export function SubscriptionsTable({
  products,
  creditPlans,
  onCancel,
}: {
  products: ReadonlyArray<ProductSource>;
  creditPlans: ReadonlyArray<Subscription>;
  onCancel: (pending: PendingCancel) => void;
}) {
  const { t } = useTranslation();
  const dates = useDateFormat();

  const rows = useMemo<SubscriptionRow[]>(
    () => [
      ...products.map(
        (source): SubscriptionRow => ({
          id: source.sourceId,
          kind: 'product',
          name: source.offers.map((offer) => offer.displayName).join(', '),
          detail: source.offers
            .flatMap((offer) => offer.products.map((product) => product.displayName))
            .join(', '),
          status: source.status,
          periodEnd: source.period.end,
          cancelsAtPeriodEnd: source.cancelAtPeriodEnd,
          canCancel: source.canCancel,
        }),
      ),
      ...creditPlans.map(
        (plan): SubscriptionRow => ({
          id: plan._id,
          kind: 'credit',
          name: plan.plan.name,
          detail: t('billingPage.plans.creditsPerMonth', {
            credits: formatCount(plan.plan.creditsPerMonth),
          }),
          status: plan.status,
          periodEnd: plan.currentPeriodEnd,
          cancelsAtPeriodEnd: plan.cancelAtPeriodEnd,
          canCancel: true,
        }),
      ),
    ],
    [products, creditPlans, t],
  );

  const columns = useMemo<DataTableColumn<SubscriptionRow>[]>(
    () => [
      {
        id: 'name',
        header: t('billingPage.plans.columns.plan'),
        flex: 1.6,
        accessor: (row) => row.name,
        sortDescFirst: false,
        cell: ({ row }) => (
          <View className="w-full min-w-0">
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {row.name}
            </Text>
            {row.detail === '' ? null : (
              <Muted className="text-xs text-muted-foreground" numberOfLines={1}>
                {row.detail}
              </Muted>
            )}
          </View>
        ),
      },
      {
        id: 'kind',
        header: t('billingPage.plans.columns.type'),
        accessor: (row) => row.kind,
        cell: ({ row }) => (
          <Chip size="md" hue={row.kind === 'product' ? 'purple' : 'blue'}>
            {t(`billingPage.plans.kinds.${row.kind}`)}
          </Chip>
        ),
      },
      {
        id: 'status',
        header: t('billingPage.plans.columns.status'),
        accessor: (row) => row.status,
        cell: ({ row }) => (
          <Chip size="md" hue={STATUS_HUE[row.status] ?? 'gray'}>
            {row.cancelsAtPeriodEnd ? t('billingPage.plans.cancelsAtPeriodEnd') : row.status}
          </Chip>
        ),
      },
      {
        id: 'period',
        header: t('billingPage.plans.columns.through'),
        accessor: (row) => Date.parse(row.periodEnd),
        cell: ({ row }) => <Muted>{dates.date(row.periodEnd)}</Muted>,
      },
      {
        id: 'actions',
        header: t('billingPage.plans.columns.actions'),
        width: 100,
        cell: ({ row }) =>
          row.cancelsAtPeriodEnd || !row.canCancel ? null : (
            <DataTableRowActions
              name={row.name}
              actions={[
                {
                  icon: RiCloseCircleLine,
                  label: t(
                    row.kind === 'product'
                      ? 'billingPage.plans.cancelSubscription'
                      : 'billingPage.plans.cancelCreditPlan',
                  ),
                  onPress: () => onCancel({ kind: row.kind, id: row.id, name: row.name }),
                },
              ]}
            />
          ),
      },
    ],
    [onCancel, t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.plans.subscriptionsLabel')}
      rows={rows}
      columns={columns}
      getRowId={(row) => `${row.kind}-${row.id}`}
      title={t('billingPage.plans.subscriptionsTitle')}
      summary={t('billingPage.plans.subscriptionsSummary', { count: rows.length })}
      pageSize={6}
      minWidth={640}
      emptyState={
        <EmptyState
          variant="compact"
          icon={RiVipCrownLine}
          title={t('billingPage.plans.noSubscriptions')}
          description={t('billingPage.plans.freeRefresh')}
        />
      }
    />
  );
}
