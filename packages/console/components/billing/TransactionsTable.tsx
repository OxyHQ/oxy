import { Chip, type ChipHue } from '@oxy.so/bloom/chip';
import { DataTable, type DataTableColumn, DataTableSearch } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiReceiptLine } from '@oxy.so/bloom/icons/RiReceiptLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';

import type { Transaction } from '@/hooks/use-billing';
import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';

const STATUS_HUE: Record<Transaction['status'], ChipHue> = {
  completed: 'lime',
  pending: 'yellow',
  failed: 'rose',
  refunded: 'gray',
};

/** Credit purchases, subscription payments and refunds. Amounts are provider cents. */
export function TransactionsTable({ transactions }: { transactions: ReadonlyArray<Transaction> }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const describe = (transaction: Transaction) =>
    transaction.description || transaction.type.replaceAll('_', ' ');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ''
      ? transactions
      : transactions.filter((transaction) =>
          (transaction.description || transaction.type.replaceAll('_', ' '))
            .toLowerCase()
            .includes(needle),
        );
  }, [transactions, query]);

  const columns = useMemo<DataTableColumn<Transaction>[]>(
    () => [
      {
        id: 'date',
        header: t('billingPage.plans.transactionsColumns.date'),
        accessor: (row) => Date.parse(row.createdAt),
        cell: ({ row }) => <Muted>{new Date(row.createdAt).toLocaleDateString()}</Muted>,
      },
      {
        id: 'description',
        header: t('billingPage.plans.transactionsColumns.description'),
        flex: 1.6,
        accessor: (row) => describe(row),
        sortDescFirst: false,
        cell: ({ row }) => <Text numberOfLines={1}>{describe(row)}</Text>,
      },
      {
        id: 'status',
        header: t('billingPage.plans.transactionsColumns.status'),
        accessor: (row) => row.status,
        cell: ({ row }) => (
          <Chip size="md" hue={STATUS_HUE[row.status]}>
            {row.status}
          </Chip>
        ),
      },
      {
        id: 'credits',
        header: t('billingPage.plans.transactionsColumns.credits'),
        accessor: (row) => row.credits,
        cell: ({ row }) => (
          <Text className="tabular-nums">
            {t('billingPage.plans.plusCredits', { credits: formatCount(row.credits) })}
          </Text>
        ),
      },
      {
        id: 'amount',
        header: t('billingPage.plans.transactionsColumns.amount'),
        align: 'end',
        accessor: (row) => row.amount,
        cell: ({ row }) => (
          <Text className="tabular-nums">
            {(row.amount / 100).toFixed(2)} {row.currency.toUpperCase()}
          </Text>
        ),
      },
    ],
    [t],
  );

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.plans.transactionsLabel')}
      rows={rows}
      columns={columns}
      getRowId={(row) => row._id}
      title={t('billingPage.plans.transactions')}
      summary={t('billingPage.plans.transactionsSummary', { count: rows.length })}
      toolbar={
        <DataTableSearch
          label={t('billingPage.plans.searchTransactions')}
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setPage(1);
          }}
        />
      }
      defaultSort={{ columnId: 'date', direction: 'descending' }}
      page={page}
      onPageChange={setPage}
      pageSize={8}
      minWidth={680}
      emptyState={
        <EmptyState
          variant="compact"
          icon={RiReceiptLine}
          title={t('billingPage.plans.noTransactions')}
        />
      }
    />
  );
}
