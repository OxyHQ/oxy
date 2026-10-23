import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { FormSkeleton, TableSkeleton } from '@/components/loading/ContentSkeleton';
import { useClarityQuotas, useClarityUsage } from '@/hooks/use-clarity';
import { useTranslation } from '@/lib/i18n';

/** Account quotas beside the measured usage ledger. */
export function ClarityUsage() {
  const { t } = useTranslation();
  const usage = useClarityUsage();
  const quotas = useClarityQuotas();

  type UsageRow = NonNullable<typeof usage.data>['data'][number];
  const columns: Array<DataTableColumn<UsageRow>> = [
    {
      id: 'operation',
      header: t('clarityPage.usage.operation'),
      basis: 240,
      accessor: (row) => row.operation,
      cell: ({ row }) => t(`clarityPage.usage.operations.${row.operation}`),
    },
    {
      id: 'period',
      header: t('clarityPage.usage.period'),
      basis: 200,
      accessor: (row) => row.periodStart,
      cell: ({ row }) => new Date(row.periodStart).toLocaleDateString(),
    },
    {
      id: 'quantity',
      header: t('clarityPage.usage.quantity'),
      basis: 120,
      accessor: (row) => row.quantity,
      cell: ({ row }) => row.quantity.toLocaleString(),
    },
  ];

  return (
    <View className="flex-row flex-wrap gap-6">
      <View className="min-w-72 flex-1 basis-96">
        <Card>
          <CardHeader>
            <CardTitle>{t('clarityPage.usage.quotasTitle')}</CardTitle>
            <CardDescription>{t('clarityPage.usage.quotasDescription')}</CardDescription>
          </CardHeader>
          <CardBody>
            {quotas.isLoading ? (
              <FormSkeleton count={3} />
            ) : quotas.isError ? (
              <ApiState error={quotas.error} onRetry={quotas.refetch} />
            ) : (
              quotas.data && (
                <GroupedSection separator="line" variant="plain">
                  {Object.entries(quotas.data).map(([key, value]) => (
                    <GroupedSectionItem
                      key={key}
                      title={t(`clarityPage.usage.quota.${key}`)}
                      value={value.toLocaleString()}
                    />
                  ))}
                </GroupedSection>
              )
            )}
          </CardBody>
        </Card>
      </View>
      <View className="min-w-72 flex-1 basis-96">
        {usage.isLoading ? (
          <TableSkeleton columns={3} />
        ) : usage.isError ? (
          <ApiState error={usage.error} onRetry={usage.refetch} />
        ) : (
          <DataTable
            layout="inset"
            rows={usage.data?.data ?? []}
            columns={columns}
            getRowId={(row) => `${row.operation}-${row.periodStart}`}
            accessibilityLabel={t('clarityPage.usage.measuredTitle')}
            title={t('clarityPage.usage.measuredTitle')}
            summary={t('clarityPage.usage.measuredDescription')}
            pageSize={10}
            minWidth={520}
            emptyState={<EmptyState variant="compact" title={t('clarityPage.usage.none')} />}
          />
        )}
      </View>
    </View>
  );
}
