import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { useReportLabels } from '@/components/billing/labels';
import { ProvenanceBanner, ProvenanceCrossReference } from '@/components/billing/provenance-banner';
import { ReportControls } from '@/components/billing/report-controls';
import { useAccount } from '@/hooks/use-account';
import { useAccountSpendReport } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { compareExactDecimals, formatCount, formatMoney } from '@/lib/money';
import {
  type ReportRangeDays,
  SPEND_DIMENSIONS,
  type SpendDimension,
  type SpendRow,
  lastCalendarDays,
  spendDimensionValue,
} from '@/lib/reporting';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * What the account was actually charged, by application, model, provider and time.
 *
 * Money, and only money: every figure comes from `usage_receipts` with reversals
 * from `usage_refunds` — the financial ledger. `receiptCount` is how many settled
 * receipts a row aggregates, a property of the BILL, not of the traffic; request
 * and token counts live on the Usage page. Totals are per currency and this page
 * never adds one to another; rows are ordered by a string comparison of the exact
 * decimals so sorting cannot cost a digit.
 */
export default function BillingSpendPage() {
  const { t } = useTranslation();
  const labels = useReportLabels();
  const { currentAccount, canReadBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);

  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(30);
  const [groupBy, setGroupBy] = useState<ReadonlyArray<SpendDimension>>(['application']);
  const [includeDescendants, setIncludeDescendants] = useState(false);

  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);
  const spendQuery = useAccountSpendReport(
    accountId,
    { range, groupBy, includeDescendants },
    canRead,
  );
  const report = spendQuery.data;

  const rows = useMemo(() => {
    if (report === undefined) {
      return [];
    }
    return [...report.rows].sort((left, right) =>
      compareExactDecimals(right.netAmount, left.netAmount),
    );
  }, [report]);

  const columns = useMemo<ReadonlyArray<DataTableColumn<SpendRow>>>(
    () => [
      ...groupBy.map(
        (dimension): DataTableColumn<SpendRow> => ({
          id: dimension,
          header: labels.dimension(dimension),
          minWidth: 140,
          cell: ({ row }) => (
            <Text className="font-mono text-xs">{spendDimensionValue(row, dimension)}</Text>
          ),
        }),
      ),
      {
        id: 'receipts',
        header: t('billingPage.spend.receipts'),
        align: 'end',
        width: 110,
        cell: ({ row }) => <Muted className="tabular-nums">{formatCount(row.receiptCount)}</Muted>,
      },
      {
        id: 'refunded',
        header: t('billingPage.spend.refunded'),
        align: 'end',
        width: 140,
        cell: ({ row }) => (
          <Muted className="tabular-nums">{formatMoney(row.refundedAmount, row.currency)}</Muted>
        ),
      },
      {
        id: 'net',
        header: t('billingPage.spend.net'),
        align: 'end',
        width: 150,
        cell: ({ row }) => (
          <Text className="tabular-nums">{formatMoney(row.netAmount, row.currency)}</Text>
        ),
      },
    ],
    [groupBy, labels, t],
  );

  const groupedBy = t('reportKit.by', {
    dimensions: groupBy.map(labels.dimension).join(', ').toLowerCase(),
  });

  return (
    <ScreenScrollView contentContainerClassName="gap-6 px-4 py-6 pb-12">
      {!canRead ? (
        <EmptyState icon={RiLockLine} title={t('billingPage.spend.denied')} />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />
          <ProvenanceCrossReference provenance={LEDGER} />

          <ReportControls
            rangeDays={rangeDays}
            onRangeDaysChange={setRangeDays}
            dimensions={SPEND_DIMENSIONS}
            selected={groupBy}
            onSelectedChange={setGroupBy}
            dimensionLabel={labels.dimension}
          />
          <Checkbox
            checked={includeDescendants}
            onCheckedChange={setIncludeDescendants}
            label={t('reportKit.includeDescendants')}
          />

          {spendQuery.isLoading ? (
            <Skeleton.Box width="100%" height={176} />
          ) : report === undefined || report.totals.length === 0 ? (
            <Muted>{t('billingPage.spend.nothing')}</Muted>
          ) : (
            report.totals.map((total) => (
              <GroupedSection
                key={total.currency}
                title={`${t('billingPage.spend.billed', { from: range.from, to: range.to })} · ${total.currency}`}
              >
                <GroupedSectionItem
                  title={t('billingPage.spend.netCharged')}
                  description={t('billingPage.spend.netChargedHint')}
                  value={formatMoney(total.netAmount, total.currency)}
                />
                <GroupedSectionItem
                  title={t('billingPage.spend.beforeReversals')}
                  description={t('billingPage.spend.beforeReversalsHint')}
                  value={formatMoney(total.billedAmount, total.currency)}
                />
                <GroupedSectionItem
                  title={t('billingPage.spend.refundedTotal')}
                  description={t('billingPage.spend.refundedHint')}
                  value={formatMoney(total.refundedAmount, total.currency)}
                />
                <GroupedSectionItem
                  title={t('billingPage.spend.receiptsTotal')}
                  description={t('billingPage.spend.receiptsHint')}
                  value={formatCount(total.receiptCount)}
                />
              </GroupedSection>
            ))
          )}

          <Card>
            <CardHeader>
              <CardTitle>{groupedBy}</CardTitle>
            </CardHeader>
            <CardBody>
              {spendQuery.isLoading ? (
                <Skeleton.Box width="100%" height={132} />
              ) : (
                <DataTable
                  rows={rows}
                  columns={columns}
                  getRowId={(row, index) =>
                    `${groupBy.map((dimension) => spendDimensionValue(row, dimension)).join('|')}-${row.currency}-${index}`
                  }
                  accessibilityLabel={t('billingPage.spend.tableLabel')}
                  minWidth={560}
                  emptyState={
                    <EmptyState variant="compact" title={t('billingPage.spend.noCharges')} />
                  }
                />
              )}
              {report?.truncated === true && <Muted>{t('billingPage.spend.truncated')}</Muted>}
            </CardBody>
          </Card>
        </>
      )}
    </ScreenScrollView>
  );
}
