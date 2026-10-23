import type { AutoRechargeAttempt } from '@oxy.so/contracts';
import { Chip, type ChipHue } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiRepeatLine } from '@oxy.so/bloom/icons/RiRepeatLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';

import { useDateFormat } from '@/hooks/use-date-format';
import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';

const STATUS_HUE: Record<AutoRechargeAttempt['status'], ChipHue> = {
  succeeded: 'lime',
  failed: 'rose',
  pending: 'yellow',
};

/** What the automatic top-up sweep did, newest first, with the failure code when it failed. */
export function AutoRechargeAttempts({
  attempts,
}: {
  attempts: ReadonlyArray<AutoRechargeAttempt>;
}) {
  const { t } = useTranslation();
  const dates = useDateFormat();

  const columns = useMemo<DataTableColumn<AutoRechargeAttempt>[]>(
    () => [
      {
        id: 'when',
        header: t('billingPage.attempts.when'),
        flex: 1.2,
        accessor: (row) => Date.parse(row.createdAt),
        cell: ({ row }) => (
          <Text className="text-sm text-foreground">{dates.dateTime(row.createdAt)}</Text>
        ),
      },
      {
        id: 'trigger',
        header: t('billingPage.attempts.trigger'),
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatMoney(row.balanceAtTrigger, row.currency)}
          </Muted>
        ),
      },
      {
        id: 'status',
        header: t('billingPage.attempts.status'),
        accessor: (row) => row.status,
        cell: ({ row }) => (
          <Chip size="md" hue={STATUS_HUE[row.status]}>
            {row.failureCode ?? t(`billingPage.attempts.statuses.${row.status}`)}
          </Chip>
        ),
      },
      {
        id: 'amount',
        header: t('billingPage.attempts.amount'),
        align: 'end',
        cell: ({ row }) => (
          <Text className="text-sm tabular-nums text-foreground">
            {formatMoney(row.requestedAmount, row.currency)}
          </Text>
        ),
      },
    ],
    [dates, t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.attempts.label')}
      rows={attempts}
      columns={columns}
      getRowId={(row) => row.id}
      title={t('billingPage.attempts.title')}
      summary={t('billingPage.attempts.summary', { count: attempts.length })}
      pageSize={5}
      minWidth={560}
      emptyState={
        <EmptyState variant="compact" icon={RiRepeatLine} title={t('billingPage.attempts.empty')} />
      }
    />
  );
}
