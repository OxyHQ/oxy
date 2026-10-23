import type { BillingInvoice } from '@oxy.so/contracts';
import { Chip, type ChipHue } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiReceiptLine } from '@oxy.so/bloom/icons/RiReceiptLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';

import { useDateFormat } from '@/hooks/use-date-format';
import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';
import { plotNumber } from '@/lib/reporting-charts';

const STATUS_HUE: Record<BillingInvoice['status'], ChipHue> = {
  paid: 'lime',
  open: 'yellow',
  draft: 'gray',
  void: 'rose',
};

/** The account's invoices, newest period first. A prepaid account has none. */
export function InvoicesTable({ invoices }: { invoices: ReadonlyArray<BillingInvoice> }) {
  const { t } = useTranslation();
  const dates = useDateFormat();

  const columns = useMemo<DataTableColumn<BillingInvoice>[]>(
    () => [
      {
        id: 'period',
        header: t('billingPage.invoices.period'),
        flex: 1.4,
        accessor: (row) => Date.parse(row.periodStart),
        cell: ({ row }) => (
          <Text className="text-sm text-foreground">
            {dates.date(row.periodStart)} – {dates.date(row.periodEnd)}
          </Text>
        ),
      },
      {
        id: 'charges',
        header: t('billingPage.invoices.charges'),
        accessor: (row) => row.receiptCount,
        cell: ({ row }) => (
          <Muted className="text-sm tabular-nums text-muted-foreground">
            {formatCount(row.receiptCount)}
          </Muted>
        ),
      },
      {
        id: 'status',
        header: t('billingPage.invoices.status'),
        accessor: (row) => row.status,
        cell: ({ row }) => (
          <Chip size="md" hue={STATUS_HUE[row.status]}>
            {t(`billingPage.invoices.statuses.${row.status}`)}
          </Chip>
        ),
      },
      {
        id: 'total',
        header: t('billingPage.invoices.total'),
        align: 'end',
        // Sort order only; the cell shows the exact string.
        accessor: (row) => plotNumber(row.totalAmount),
        cell: ({ row }) => (
          <Text className="text-sm tabular-nums text-foreground">
            {formatMoney(row.totalAmount, row.currency)}
          </Text>
        ),
      },
    ],
    [dates, t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.invoices.label')}
      rows={invoices}
      columns={columns}
      getRowId={(row) => row.id}
      title={t('billingPage.invoices.title')}
      summary={t('billingPage.invoices.summary', { count: invoices.length })}
      pageSize={6}
      minWidth={560}
      emptyState={
        <EmptyState
          variant="compact"
          icon={RiReceiptLine}
          title={t('billingPage.invoices.emptyTitle')}
          description={t('billingPage.invoices.emptyBody')}
        />
      }
    />
  );
}
