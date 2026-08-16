import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { ReportRangeDays } from '@/lib/reporting';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BillingHeader } from '@/components/billing/billing-header';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { usePendingReservations, useSettledCharges } from '@/hooks/use-inference-reporting';
import { formatCount, formatMoney } from '@/lib/money';
import { REPORT_RANGE_DAYS, lastCalendarDays } from '@/lib/reporting';

/**
 * Two lists that are deliberately not one: money HELD, and money CHARGED.
 *
 * A reservation is an authorisation taken before a request runs, sized on its
 * maximum possible cost. When the request finishes it settles for the exact
 * amount — usually much less — and the unused part is released. Nothing on the
 * holds list has been charged, and the epic asks for the two shown separately
 * for exactly that reason: presenting a hold as a charge makes a balance appear
 * to drop and recover on every request with no way to tell why.
 *
 * Both read the financial ledger and carry the same authoritative stamp, so the
 * distinction here is between two ledger STATES rather than between two sources.
 * The banner says so once, and each section says which state it is.
 *
 * The token counts in the charges table are the RECEIPT's own units — what the
 * charge was computed from — and not the telemetry rollups the Usage page reads.
 * That is why they may appear beside an amount here and nowhere else: they came
 * out of the same row, in the same transaction, as the money next to them.
 */
export const Route = createFileRoute('/_layout/billing/charges')({
  component: BillingChargesPage,
});

function BillingChargesPage() {
  const { currentAccount, canReadBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);

  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(7);
  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);

  const reservationsQuery = usePendingReservations(accountId, 100, canRead);
  const chargesQuery = useSettledCharges(accountId, range, 100, canRead);

  const held = reservationsQuery.data;
  const charges = chargesQuery.data;

  return (
    <ScrollArea className="flex-1 bg-background">
      <BillingHeader
        active="charges"
        accountName={currentAccount === null ? undefined : accountLabel(currentAccount)}
      />

      {!canRead ? (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
          You do not have permission to see this account's charges.
        </div>
      ) : (
        <>
          <div className="px-6 py-6 border-b border-border">
            <ProvenanceBanner
              provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
            />
          </div>

          {/* Pending reservations */}
          <div className="px-6 py-6 border-b border-border">
            <p className="text-sm font-semibold text-foreground">Held, not charged</p>
            <p className="mt-0.5 mb-4 text-sm text-muted-foreground max-w-2xl">
              Money authorised against requests currently in flight, sized on the maximum the
              request could cost. Nothing here has been charged. When a request finishes it settles
              for the exact amount and moves to the list below — usually for less.
            </p>

            {reservationsQuery.isLoading ? (
              <Skeleton.Box width="100%" height={64} />
            ) : held === undefined || held.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is held right now.</p>
            ) : (
              <>
                <div className="mb-4 flex flex-row flex-wrap gap-12">
                  {held.totals.map((total) => (
                    <div key={total.currency}>
                      <p className="text-2xl font-semibold text-foreground tabular-nums">
                        {formatMoney(total.heldAmount, total.currency)}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        held across {formatCount(total.reservationCount)} requests
                      </p>
                    </div>
                  ))}
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left">
                        <th className="px-4 py-2 font-medium text-muted-foreground">Request</th>
                        <th className="px-4 py-2 font-medium text-muted-foreground">Application</th>
                        <th className="px-4 py-2 font-medium text-muted-foreground">Environment</th>
                        <th className="px-4 py-2 font-medium text-muted-foreground">Expires</th>
                        <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                          Held
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {held.rows.map((reservation) => (
                        <tr
                          key={reservation.reservationId}
                          className="border-b border-border last:border-0"
                        >
                          <td className="px-4 py-2 font-mono text-xs text-foreground">
                            {reservation.requestId}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                            {reservation.applicationId}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {reservation.environment}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {new Date(reservation.expiresAt).toLocaleTimeString()}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-foreground">
                            {formatMoney(reservation.reservedAmount, reservation.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* Settled charges */}
          <div className="px-6 py-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Charged</p>
                <p className="mt-0.5 mb-4 text-sm text-muted-foreground max-w-2xl">
                  Settled receipts, for the exact amount served. This is the per-request detail
                  behind the Spend totals.
                </p>
              </div>
              <div className="flex gap-1">
                {REPORT_RANGE_DAYS.map((days) => (
                  <Button
                    key={days}
                    variant={rangeDays === days ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setRangeDays(days)}
                  >
                    {days}d
                  </Button>
                ))}
              </div>
            </div>

            {chargesQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((index) => (
                  <Skeleton.Box key={index} width="100%" height={44} />
                ))}
              </div>
            ) : charges === undefined || charges.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing was charged between {range.from} and {range.to}.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left">
                      <th className="px-4 py-2 font-medium text-muted-foreground">Settled</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Served model</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Provider</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Outcome</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                        Tokens in / out
                      </th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                        Net charged
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {charges.rows.map((charge) => (
                      <tr key={charge.receiptId} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 text-muted-foreground">
                          {new Date(charge.settledAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-foreground">
                          {charge.resolvedModelReference}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{charge.servingProvider}</td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={charge.outcome === 'completed' ? 'default' : 'secondary'}>
                              {charge.outcome}
                            </Badge>
                            {charge.platformFeeOnly && (
                              <Badge variant="outline" title="Your own provider key served this request; Oxy billed its fee only">
                                fee only
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {formatCount(charge.units.input_tokens)} /{' '}
                          {formatCount(charge.units.output_tokens)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-foreground">
                          {formatMoney(charge.netAmount, charge.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {charges?.truncated === true && (
              <p className="mt-3 text-xs text-muted-foreground">
                More charges matched than were returned. Narrow the period — this list is not the
                whole of it.
              </p>
            )}
          </div>
        </>
      )}
    </ScrollArea>
  );
}
