import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { ReportRangeDays, SpendDimension } from '@/lib/reporting';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BillingHeader } from '@/components/billing/billing-header';
import {
  ProvenanceBanner,
  ProvenanceCrossReference,
} from '@/components/billing/provenance-banner';
import { ReportControls } from '@/components/billing/report-controls';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { useAccountSpendReport } from '@/hooks/use-inference-reporting';
import { compareExactDecimals, formatCount, formatMoney } from '@/lib/money';
import {
  SPEND_DIMENSIONS,
  lastCalendarDays,
  spendDimensionLabel,
  spendDimensionValue,
} from '@/lib/reporting';

/**
 * What the account was actually charged, by application, model, provider and
 * time.
 *
 * ## Money, and only money
 *
 * Every figure here comes from `usage_receipts` with reversals from
 * `usage_refunds` — the financial ledger — and the response says so about itself
 * in fields the server cannot omit. There is no request count that could be read
 * as a charge and no token count that could be read as a price: `receiptCount`
 * is how many settled receipts a row aggregates, which is a property of the
 * BILL, not of the traffic. Request and token counts live on the Usage page,
 * which is telemetry and says so.
 *
 * ## Totals are per currency, and this page never adds one
 *
 * `/spend` returns one total per currency, because summing two currencies is
 * arithmetic on incomparable quantities. Rows are sorted with a string
 * comparison of the exact decimals (`compareExactDecimals`) rather than by
 * parsing them, so ordering the table cannot cost a digit.
 */
export const Route = createFileRoute('/_layout/billing/spend')({
  component: BillingSpendPage,
});

function BillingSpendPage() {
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
    canRead
  );
  const report = spendQuery.data;

  const rows = useMemo(() => {
    if (report === undefined) {
      return [];
    }
    return [...report.rows].sort((left, right) =>
      compareExactDecimals(right.netAmount, left.netAmount)
    );
  }, [report]);

  return (
    <ScrollArea className="flex-1 bg-background">
      <BillingHeader
        active="spend"
        accountName={currentAccount === null ? undefined : accountLabel(currentAccount)}
      />

      {!canRead ? (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
          You do not have permission to see this account's spend.
        </div>
      ) : (
        <>
          <div className="px-6 py-6 border-b border-border space-y-4">
            <ProvenanceBanner
              provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
            />
            <ProvenanceCrossReference
              provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
            />
          </div>

          <div className="px-6 py-6 border-b border-border space-y-4">
            <ReportControls
              rangeDays={rangeDays}
              onRangeDaysChange={setRangeDays}
              dimensions={SPEND_DIMENSIONS}
              selected={groupBy}
              onSelectedChange={setGroupBy}
              dimensionLabel={spendDimensionLabel}
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={includeDescendants}
                onChange={(event) => setIncludeDescendants(event.target.checked)}
                className="size-4 accent-foreground"
              />
              Include projects under this account
            </label>
          </div>

          {/* Totals */}
          <div className="px-6 py-6 border-b border-border">
            <p className="text-sm font-semibold text-foreground mb-4">
              Billed {range.from} to {range.to}
            </p>
            {spendQuery.isLoading ? (
              <div className="flex flex-row gap-12">
                {[1, 2, 3].map((index) => (
                  <Skeleton.Box key={index} width={128} height={48} />
                ))}
              </div>
            ) : report === undefined || report.totals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing was charged to this account in this period.
              </p>
            ) : (
              <div className="space-y-6">
                {report.totals.map((total) => (
                  <div key={total.currency} className="flex flex-row flex-wrap gap-12">
                    <Figure
                      label="Net charged"
                      hint="Settled, less reversals. The figure an invoice reconciles against."
                      value={formatMoney(total.netAmount, total.currency)}
                    />
                    <Figure
                      label="Billed before reversals"
                      hint="What was settled at request time."
                      value={formatMoney(total.billedAmount, total.currency)}
                    />
                    <Figure
                      label="Refunded"
                      hint="Reversed by a compensating entry. Settled history is never edited."
                      value={formatMoney(total.refundedAmount, total.currency)}
                    />
                    <Figure
                      label="Receipts"
                      hint="Settled receipts on this bill, not requests served."
                      value={formatCount(total.receiptCount)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Rows */}
          <div className="px-6 py-6">
            <p className="text-sm font-semibold text-foreground mb-4">
              By {groupBy.map(spendDimensionLabel).join(', ').toLowerCase()}
            </p>
            {spendQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((index) => (
                  <Skeleton.Box key={index} width="100%" height={44} />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No charges in this period.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left">
                      {groupBy.map((dimension) => (
                        <th key={dimension} className="px-4 py-2 font-medium text-muted-foreground">
                          {spendDimensionLabel(dimension)}
                        </th>
                      ))}
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                        Receipts
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                        Refunded
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                        Net charged
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr
                        key={`${groupBy.map((dimension) => spendDimensionValue(row, dimension)).join('|')}-${row.currency}-${index}`}
                        className="border-b border-border last:border-0"
                      >
                        {groupBy.map((dimension) => (
                          <td key={dimension} className="px-4 py-2 text-foreground">
                            <span className="font-mono text-xs">
                              {spendDimensionValue(row, dimension)}
                            </span>
                          </td>
                        ))}
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {formatCount(row.receiptCount)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {formatMoney(row.refundedAmount, row.currency)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-foreground">
                          {formatMoney(row.netAmount, row.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report?.truncated === true && (
              <p className="mt-3 text-xs text-muted-foreground">
                More rows matched than were returned. Narrow the period or the grouping — this table
                is not the whole period.
              </p>
            )}
          </div>
        </>
      )}
    </ScrollArea>
  );
}

function Figure({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="min-w-40">
      <p className="text-2xl font-semibold text-foreground tabular-nums">{value}</p>
      <p className="mt-0.5 text-sm text-foreground">{label}</p>
      <p className="mt-0.5 text-xs text-muted-foreground max-w-56">{hint}</p>
    </div>
  );
}
