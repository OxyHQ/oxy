import { Link, createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { ReportRangeDays, UsageDimension, UsageRow } from '@/lib/reporting';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ProvenanceBanner,
  ProvenanceCrossReference,
} from '@/components/billing/provenance-banner';
import { ReportControls } from '@/components/billing/report-controls';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { useApplications } from '@/hooks/use-applications';
import { useAccountUsageReport } from '@/hooks/use-inference-reporting';
import { formatCount } from '@/lib/money';
import {
  USAGE_DIMENSIONS,
  lastCalendarDays,
  usageDimensionLabel,
  usageDimensionValue,
} from '@/lib/reporting';

/**
 * What the account CONSUMED — requests, tokens, images — over a period.
 *
 * ## There is no money on this page, and that is the point
 *
 * These figures come from `inference_usage_daily_rollups`, which is telemetry
 * maintained outside the ledger transaction: a recent request may not be counted
 * yet, and a dropped recorder may never count one. The API stamps every response
 * here `{ source: 'usage_telemetry_rollups', consistency: 'eventual' }`, the
 * banner renders that stamp, and the response type carries the two values as
 * literals so a component cannot show these rows under a ledger heading.
 *
 * The exact billed amount is a different table and a different page — Billing →
 * Spend — and the cross-reference at the top says so rather than leaving a
 * customer to assume the two agree. They will not always.
 */
export const Route = createFileRoute('/_layout/usage')({
  component: UsagePage,
});

const TELEMETRY = { source: 'usage_telemetry_rollups', consistency: 'eventual' } as const;

function UsagePage() {
  const { currentAccount, canReadBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);

  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(30);
  const [groupBy, setGroupBy] = useState<ReadonlyArray<UsageDimension>>(['day']);
  const [includeDescendants, setIncludeDescendants] = useState(false);

  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);
  const usageQuery = useAccountUsageReport(
    accountId,
    { range, groupBy, includeDescendants },
    canRead
  );
  const report = usageQuery.data;

  const applicationsQuery = useApplications();
  const applications = applicationsQuery.data ?? [];

  /**
   * Whole counts, so ordinary arithmetic is exact — these are integers from the
   * rollups, not amounts of money. The same sum over a spend report would be the
   * float bug the ledger exists to avoid, which is why no such sum exists there.
   */
  const totals = useMemo(() => summariseUsage(report?.rows ?? []), [report]);

  return (
    <ScrollArea className="flex-1 bg-background">
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Usage</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {currentAccount === null
            ? 'Requests and tokens for the account you are working in.'
            : `Requests and tokens for ${accountLabel(currentAccount)}.`}
        </p>
      </div>

      {!canRead ? (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
          You do not have permission to see this account's usage.
        </div>
      ) : (
        <>
          <div className="px-6 py-6 border-b border-border space-y-4">
            <ProvenanceBanner provenance={TELEMETRY} />
            <ProvenanceCrossReference provenance={TELEMETRY} />
          </div>

          <div className="px-6 py-6 border-b border-border space-y-4">
            <ReportControls
              rangeDays={rangeDays}
              onRangeDaysChange={setRangeDays}
              dimensions={USAGE_DIMENSIONS}
              selected={groupBy}
              onSelectedChange={setGroupBy}
              dimensionLabel={usageDimensionLabel}
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

          <div className="px-6 py-6 border-b border-border">
            <p className="text-sm font-semibold text-foreground mb-4">
              Consumed {range.from} to {range.to}
            </p>
            {usageQuery.isLoading ? (
              <div className="flex flex-row gap-12">
                {[1, 2, 3, 4].map((index) => (
                  <Skeleton.Box key={index} width={112} height={48} />
                ))}
              </div>
            ) : (
              <div className="flex flex-row flex-wrap gap-12">
                <Figure label="Requests" value={formatCount(totals.requestCount)} />
                <Figure label="Errors" value={formatCount(totals.errorCount)} />
                <Figure label="Input tokens" value={formatCount(totals.inputTokens)} />
                <Figure label="Output tokens" value={formatCount(totals.outputTokens)} />
                <Figure label="Reasoning tokens" value={formatCount(totals.reasoningTokens)} />
              </div>
            )}
            {report?.truncated === true && (
              <p className="mt-3 text-xs text-muted-foreground">
                These are totals over the rows returned, not over the period: the report was
                truncated. Narrow the period or the grouping for a complete figure.
              </p>
            )}
          </div>

          <div className="px-6 py-6 border-b border-border">
            <p className="text-sm font-semibold text-foreground mb-4">
              By {groupBy.map(usageDimensionLabel).join(', ').toLowerCase()}
            </p>
            {usageQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((index) => (
                  <Skeleton.Box key={index} width="100%" height={44} />
                ))}
              </div>
            ) : (report?.rows ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No usage recorded in this period. Telemetry lags the ledger, so a request served
                moments ago may not be counted yet.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left">
                      {groupBy.map((dimension) => (
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
                    {(report?.rows ?? []).map((row, index) => (
                      <tr
                        key={`${groupBy.map((dimension) => usageDimensionValue(row, dimension)).join('|')}-${index}`}
                        className="border-b border-border last:border-0"
                      >
                        {groupBy.map((dimension) => (
                          <td key={dimension} className="px-4 py-2 text-foreground">
                            <span className="font-mono text-xs">
                              {usageDimensionValue(row, dimension)}
                            </span>
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

            {report?.truncated === true && (
              <p className="mt-3 text-xs text-muted-foreground">
                More rows matched than were returned. Narrow the period or the grouping.
              </p>
            )}
          </div>

          <div className="px-6 py-6">
            <p className="text-sm font-semibold text-foreground mb-4">Per application</p>
            {applications.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This account owns no applications yet.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {applications.map((application) => (
                  <Link
                    key={application._id}
                    to="/apps/$appId/inference"
                    params={{ appId: application._id }}
                    className="flex items-center justify-between gap-4 px-4 py-4 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {application.name}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Usage and spend for this application
                      </p>
                    </div>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      size={16}
                      className="text-muted-foreground shrink-0"
                    />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </ScrollArea>
  );
}

interface UsageTotals {
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function summariseUsage(rows: ReadonlyArray<UsageRow>): UsageTotals {
  return rows.reduce<UsageTotals>(
    (totals, row) => ({
      requestCount: totals.requestCount + row.requestCount,
      errorCount: totals.errorCount + row.errorCount,
      inputTokens: totals.inputTokens + row.units.input_tokens,
      outputTokens: totals.outputTokens + row.units.output_tokens,
      reasoningTokens: totals.reasoningTokens + row.units.reasoning_tokens,
    }),
    { requestCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xl font-semibold text-foreground tabular-nums">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
