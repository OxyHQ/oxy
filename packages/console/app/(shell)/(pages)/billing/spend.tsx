import { Checkbox } from '@oxy.so/bloom/checkbox';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { PageBody } from '@/components/account-pages/PageFrame';
import { MonoCell, NumberCell } from '@/components/account-pages/cells';
import {
  Denied,
  Figure,
  FigureRow,
  Muted,
  Note,
  Section,
} from '@/components/account-pages/Section';
import { SkeletonFigures, SkeletonRows } from '@/components/account-pages/Skeletons';
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
          cell: ({ row }) => <MonoCell>{spendDimensionValue(row, dimension)}</MonoCell>,
        }),
      ),
      {
        id: 'receipts',
        header: t('billingPage.spend.receipts'),
        align: 'end',
        width: 110,
        cell: ({ row }) => <NumberCell muted>{formatCount(row.receiptCount)}</NumberCell>,
      },
      {
        id: 'refunded',
        header: t('billingPage.spend.refunded'),
        align: 'end',
        width: 140,
        cell: ({ row }) => (
          <NumberCell muted>{formatMoney(row.refundedAmount, row.currency)}</NumberCell>
        ),
      },
      {
        id: 'net',
        header: t('billingPage.spend.net'),
        align: 'end',
        width: 150,
        cell: ({ row }) => <NumberCell>{formatMoney(row.netAmount, row.currency)}</NumberCell>,
      },
    ],
    [groupBy, labels, t],
  );

  return (
    <PageBody>
      {!canRead ? (
        <Denied>{t('billingPage.spend.denied')}</Denied>
      ) : (
        <>
          <Section>
            <ProvenanceBanner provenance={LEDGER} />
            <ProvenanceCrossReference provenance={LEDGER} />
          </Section>

          <Section>
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
          </Section>

          <Section title={t('billingPage.spend.billed', { from: range.from, to: range.to })}>
            {spendQuery.isLoading ? (
              <SkeletonFigures count={3} />
            ) : report === undefined || report.totals.length === 0 ? (
              <Muted>{t('billingPage.spend.nothing')}</Muted>
            ) : (
              <View className="gap-6">
                {report.totals.map((total) => (
                  <FigureRow key={total.currency}>
                    <Figure
                      label={t('billingPage.spend.netCharged')}
                      hint={t('billingPage.spend.netChargedHint')}
                      value={formatMoney(total.netAmount, total.currency)}
                    />
                    <Figure
                      label={t('billingPage.spend.beforeReversals')}
                      hint={t('billingPage.spend.beforeReversalsHint')}
                      value={formatMoney(total.billedAmount, total.currency)}
                    />
                    <Figure
                      label={t('billingPage.spend.refundedTotal')}
                      hint={t('billingPage.spend.refundedHint')}
                      value={formatMoney(total.refundedAmount, total.currency)}
                    />
                    <Figure
                      label={t('billingPage.spend.receiptsTotal')}
                      hint={t('billingPage.spend.receiptsHint')}
                      value={formatCount(total.receiptCount)}
                    />
                  </FigureRow>
                ))}
              </View>
            )}
          </Section>

          <Section
            title={t('reportKit.by', {
              dimensions: groupBy.map(labels.dimension).join(', ').toLowerCase(),
            })}
            last
          >
            {spendQuery.isLoading ? (
              <SkeletonRows />
            ) : (
              <DataTable
                rows={rows}
                columns={columns}
                getRowId={(row, index) =>
                  `${groupBy.map((dimension) => spendDimensionValue(row, dimension)).join('|')}-${row.currency}-${index}`
                }
                accessibilityLabel={t('billingPage.spend.tableLabel')}
                minWidth={560}
                emptyState={<Muted>{t('billingPage.spend.noCharges')}</Muted>}
              />
            )}
            {report?.truncated === true && <Note>{t('billingPage.spend.truncated')}</Note>}
          </Section>
        </>
      )}
    </PageBody>
  );
}
