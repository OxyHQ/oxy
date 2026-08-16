import { useMemo, useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import type { ReportRangeDays, SpendDimension, UsageDimension } from '@/lib/reporting';
import {
  ProvenanceBanner,
  ProvenanceCrossReference,
} from '@/components/billing/provenance-banner';
import { ReportControls } from '@/components/billing/report-controls';
import { Button } from '@/components/ui/button';
import {
  useApplicationSpendReport,
  useApplicationUsageReport,
} from '@/hooks/use-inference-reporting';
import { compareExactDecimals, formatCount, formatMoney } from '@/lib/money';
import {
  SPEND_DIMENSIONS,
  USAGE_DIMENSIONS,
  lastCalendarDays,
  spendDimensionLabel,
  spendDimensionValue,
  usageDimensionLabel,
  usageDimensionValue,
} from '@/lib/reporting';

/** The two questions, and the two different tables that answer them. */
type Lane = 'usage' | 'spend';

const TELEMETRY = { source: 'usage_telemetry_rollups', consistency: 'eventual' } as const;
const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * One application's usage and spend.
 *
 * ## Why these are two views and not two columns of one table
 *
 * Units and money come from different tables with different consistency, and
 * `/inference/reporting` says so on every response. Putting them in one row
 * would invite exactly the reading the epic forbids — that the token count and
 * the amount beside it are two views of one record. They are not: a request
 * counted in telemetry may not be settled yet, and a settled receipt may never
 * appear in a rollup if the recorder dropped it.
 *
 * So the section has a switch, one lane at a time, each with its own banner
 * taken from its own response's stamp. Moving between them is a deliberate act,
 * and neither lane can be mistaken for the other.
 *
 * The two lanes also take different PERMISSIONS, which is the API's own split:
 * `usage:read` for units, `billing:read` for money. A developer who may see how
 * much traffic an application serves is not automatically someone who may see
 * what it costs.
 */
export function ApplicationUsageSpendSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const canReadUsage = access.can('usage:read');
  const canReadSpend = access.can('billing:read');

  const [lane, setLane] = useState<Lane>(canReadUsage ? 'usage' : 'spend');
  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(30);
  const [usageGroupBy, setUsageGroupBy] = useState<ReadonlyArray<UsageDimension>>(['day']);
  const [spendGroupBy, setSpendGroupBy] = useState<ReadonlyArray<SpendDimension>>(['day']);

  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);

  const usageQuery = useApplicationUsageReport(
    application._id,
    { range, groupBy: usageGroupBy },
    canReadUsage && lane === 'usage'
  );
  const spendQuery = useApplicationSpendReport(
    application._id,
    { range, groupBy: spendGroupBy },
    canReadSpend && lane === 'spend'
  );

  const spendRows = useMemo(() => {
    const rows = spendQuery.data?.rows ?? [];
    return [...rows].sort((left, right) => compareExactDecimals(right.netAmount, left.netAmount));
  }, [spendQuery.data]);

  if (!canReadUsage && !canReadSpend) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        You do not have permission to view this application's usage or spend.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Usage and spend</h2>
          <p className="text-sm text-muted-foreground">
            What this application consumed, and what it cost. Two different records.
          </p>
        </div>
        <div className="flex gap-1">
          {canReadUsage && (
            <Button
              variant={lane === 'usage' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setLane('usage')}
            >
              Usage
            </Button>
          )}
          {canReadSpend && (
            <Button
              variant={lane === 'spend' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setLane('spend')}
            >
              Spend
            </Button>
          )}
        </div>
      </div>

      {lane === 'usage' && canReadUsage && (
        <>
          <ProvenanceBanner provenance={TELEMETRY} />
          {canReadSpend && <ProvenanceCrossReference provenance={TELEMETRY} />}
          <ReportControls
            rangeDays={rangeDays}
            onRangeDaysChange={setRangeDays}
            dimensions={USAGE_DIMENSIONS}
            selected={usageGroupBy}
            onSelectedChange={setUsageGroupBy}
            dimensionLabel={usageDimensionLabel}
          />

          {usageQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((index) => (
                <Skeleton.Box key={index} width="100%" height={44} />
              ))}
            </div>
          ) : (usageQuery.data?.rows ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No usage recorded between {range.from} and {range.to}.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left">
                    {usageGroupBy.map((dimension) => (
                      <th key={dimension} className="px-4 py-2 font-medium text-muted-foreground">
                        {usageDimensionLabel(dimension)}
                      </th>
                    ))}
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                      Requests
                    </th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                      Errors
                    </th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                      Tokens in / out
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(usageQuery.data?.rows ?? []).map((row, index) => (
                    <tr
                      key={`${usageGroupBy.map((dimension) => usageDimensionValue(row, dimension)).join('|')}-${index}`}
                      className="border-b border-border last:border-0"
                    >
                      {usageGroupBy.map((dimension) => (
                        <td key={dimension} className="px-4 py-2 font-mono text-xs text-foreground">
                          {usageDimensionValue(row, dimension)}
                        </td>
                      ))}
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">
                        {formatCount(row.requestCount)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {formatCount(row.errorCount)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {formatCount(row.units.input_tokens)} /{' '}
                        {formatCount(row.units.output_tokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {lane === 'spend' && canReadSpend && (
        <>
          <ProvenanceBanner provenance={LEDGER} />
          {canReadUsage && <ProvenanceCrossReference provenance={LEDGER} />}
          <ReportControls
            rangeDays={rangeDays}
            onRangeDaysChange={setRangeDays}
            dimensions={SPEND_DIMENSIONS}
            selected={spendGroupBy}
            onSelectedChange={setSpendGroupBy}
            dimensionLabel={spendDimensionLabel}
          />

          {spendQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((index) => (
                <Skeleton.Box key={index} width="100%" height={44} />
              ))}
            </div>
          ) : (
            <>
              <div className="flex flex-row flex-wrap gap-12">
                {(spendQuery.data?.totals ?? []).map((total) => (
                  <div key={total.currency}>
                    <p className="text-2xl font-semibold text-foreground tabular-nums">
                      {formatMoney(total.netAmount, total.currency)}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      net charged over {formatCount(total.receiptCount)} receipts
                    </p>
                  </div>
                ))}
                {(spendQuery.data?.totals ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Nothing was charged for this application between {range.from} and {range.to}.
                  </p>
                )}
              </div>

              {spendRows.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left">
                        {spendGroupBy.map((dimension) => (
                          <th
                            key={dimension}
                            className="px-4 py-2 font-medium text-muted-foreground"
                          >
                            {spendDimensionLabel(dimension)}
                          </th>
                        ))}
                        <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                          Receipts
                        </th>
                        <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                          Net charged
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {spendRows.map((row, index) => (
                        <tr
                          key={`${spendGroupBy.map((dimension) => spendDimensionValue(row, dimension)).join('|')}-${index}`}
                          className="border-b border-border last:border-0"
                        >
                          {spendGroupBy.map((dimension) => (
                            <td
                              key={dimension}
                              className="px-4 py-2 font-mono text-xs text-foreground"
                            >
                              {spendDimensionValue(row, dimension)}
                            </td>
                          ))}
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                            {formatCount(row.receiptCount)}
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
            </>
          )}
        </>
      )}
    </div>
  );
}
