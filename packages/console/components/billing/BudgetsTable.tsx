import { Chip } from '@oxy.so/bloom/chip';
import {
  DataTable,
  type DataTableColumn,
  DataTableFilter,
  DataTableRowActions,
  DataTableSearch,
} from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';
import { RiPauseLine } from '@oxy.so/bloom/icons/RiPauseLine';
import { RiPlayCircleLine } from '@oxy.so/bloom/icons/RiPlayCircleLine';
import { Meter } from '@oxy.so/bloom/stat-bar';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { useBudgetScopeLabel } from '@/hooks/use-budget-scope-label';
import { useTranslation } from '@/lib/i18n';
import { formatBasisPoints, formatMoney } from '@/lib/money';
import type { Budget } from '@/lib/reporting';
import { plotNumber } from '@/lib/reporting-charts';

/**
 * Every budget the account owns, with how full it is.
 *
 * `currentSpend`, `remaining` and `utilizationBps` come from the same query the
 * reservation path enforces with, so this table and the refusal a customer's
 * requests get can never disagree. There is no delete, only disable.
 */
export function BudgetsTable({
  budgets,
  canManage,
  onEdit,
  onToggle,
}: {
  budgets: ReadonlyArray<Budget>;
  canManage: boolean;
  onEdit: (budget: Budget) => void;
  onToggle: (budget: Budget) => void;
}) {
  const { t } = useTranslation();
  const scopeLabel = useBudgetScopeLabel();
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return budgets.filter(
      (budget) =>
        (status === 'all' || budget.status === status) &&
        (needle === '' || scopeLabel(budget).toLowerCase().includes(needle)),
    );
  }, [budgets, status, query, scopeLabel]);

  const columns = useMemo<DataTableColumn<Budget>[]>(
    () => [
      {
        id: 'scope',
        header: t('billingPage.budgets.columns.budget'),
        flex: 1.4,
        accessor: (row) => scopeLabel(row),
        sortDescFirst: false,
        cell: ({ row }) => (
          <View>
            <Text numberOfLines={1}>{scopeLabel(row)}</Text>
            <Muted className="text-xs">
              {t(`billingPage.budgets.periods.${row.period}`)} ·{' '}
              {formatMoney(row.limitAmount, row.currency)}
            </Muted>
          </View>
        ),
      },
      {
        id: 'used',
        header: t('billingPage.budgets.columns.used'),
        flex: 1.2,
        accessor: (row) => row.utilizationBps,
        cell: ({ row }) => (
          <View className="gap-1.5">
            <Meter decorative value={Math.min(row.utilizationBps, 10000)} max={10000} />
            <Muted className="text-xs">
              {t('billingPage.budgets.used', { percent: formatBasisPoints(row.utilizationBps) })}
            </Muted>
          </View>
        ),
      },
      {
        id: 'spent',
        header: t('billingPage.budgets.columns.spent'),
        accessor: (row) => plotNumber(row.currentSpend),
        cell: ({ row }) => (
          <Text className="tabular-nums">{formatMoney(row.currentSpend, row.currency)}</Text>
        ),
      },
      {
        id: 'remaining',
        header: t('billingPage.budgets.columns.remaining'),
        accessor: (row) => plotNumber(row.remaining),
        cell: ({ row }) => (
          <Muted className="tabular-nums">{formatMoney(row.remaining, row.currency)}</Muted>
        ),
      },
      {
        id: 'enforcement',
        header: t('billingPage.budgets.columns.atCeiling'),
        accessor: (row) => row.enforcement,
        cell: ({ row }) => (
          <Chip size="md" hue="neutral">
            {t(`billingPage.budgets.enforcement.${row.enforcement}`)}
          </Chip>
        ),
      },
      {
        id: 'status',
        header: t('billingPage.budgets.columns.status'),
        accessor: (row) => row.status,
        cell: ({ row }) => (
          <Chip
            size="md"
            hue={row.status === 'disabled' ? 'gray' : row.utilizationBps >= 10000 ? 'rose' : 'lime'}
          >
            {row.status === 'disabled'
              ? t('billingPage.budgets.statusDisabled')
              : row.utilizationBps >= 10000
                ? t('billingPage.budgets.statusAtLimit')
                : t('billingPage.budgets.statusActive')}
          </Chip>
        ),
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              header: t('billingPage.budgets.columns.actions'),
              width: 120,
              cell: ({ row }) => (
                <DataTableRowActions
                  name={scopeLabel(row)}
                  actions={[
                    {
                      icon: RiEditLine,
                      label: t('billingPage.budgets.edit'),
                      onPress: () => onEdit(row),
                    },
                    {
                      icon: row.status === 'active' ? RiPauseLine : RiPlayCircleLine,
                      label: t(
                        row.status === 'active'
                          ? 'billingPage.budgets.disable'
                          : 'billingPage.budgets.rearm',
                      ),
                      onPress: () => onToggle(row),
                    },
                  ]}
                />
              ),
            } satisfies DataTableColumn<Budget>,
          ]
        : []),
    ],
    [canManage, onEdit, onToggle, scopeLabel, t],
  );

  const reset = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  return (
    <DataTable
      layout="inset"
      accessibilityLabel={t('billingPage.budgets.tableLabel')}
      rows={rows}
      columns={columns}
      getRowId={(row) => row.spendingLimitId}
      title={t('billingPage.budgets.title')}
      summary={t('billingPage.budgets.summary', { count: rows.length })}
      toolbar={
        <>
          <DataTableFilter
            label={t('billingPage.budgets.columns.status')}
            value={status}
            onValueChange={reset(setStatus)}
            options={[
              { value: 'all', label: t('billingPage.budgets.allStatuses') },
              { value: 'active', label: t('billingPage.budgets.statusActive') },
              { value: 'disabled', label: t('billingPage.budgets.statusDisabled') },
            ]}
          />
          <DataTableSearch
            label={t('billingPage.budgets.search')}
            value={query}
            onValueChange={reset(setQuery)}
          />
        </>
      }
      page={page}
      onPageChange={setPage}
      pageSize={8}
      minWidth={900}
      emptyState={
        <EmptyState
          variant="compact"
          icon={RiFocus3Line}
          title={t('billingPage.budgets.noneTitle')}
          description={t('billingPage.budgets.none')}
        />
      }
    />
  );
}
