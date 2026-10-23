import { ScreenScrollView } from '@oxy.so/bloom/screen';
import { useMemo, useState } from 'react';

import { ChargesTable } from '@/components/billing/ChargesTable';
import { HoldsTable } from '@/components/billing/HoldsTable';
import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { NoBillingAccess } from '@/components/reporting/NoBillingAccess';
import { ProvenanceBanner } from '@/components/reporting/ProvenanceBanner';
import { useBillingAccess } from '@/hooks/use-billing-access';
import { usePendingReservations, useSettledCharges } from '@/hooks/use-inference-reporting';
import { type ReportRangeDays, lastCalendarDays } from '@/lib/reporting';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * Two lists that are deliberately not one: money HELD, and money CHARGED.
 *
 * Presenting a hold as a charge makes a balance look like it drops and recovers on
 * every request with no way to tell why, so each has its own table and its own
 * explanation. Both are read from the financial ledger.
 */
export default function BillingChargesPage() {
  const { accountId, canRead } = useBillingAccess();
  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(7);
  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);

  const held = usePendingReservations(accountId, 100, canRead);
  const charges = useSettledCharges(accountId, range, 100, canRead);

  return (
    <ScreenScrollView contentContainerClassName="gap-4 p-4 pb-12">
      {!canRead ? (
        <NoBillingAccess />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />

          {held.isLoading ? (
            <TableSkeleton rows={3} />
          ) : held.isError ? (
            <ApiState error={held.error} onRetry={() => void held.refetch()} />
          ) : held.data === undefined ? null : (
            <HoldsTable held={held.data} />
          )}

          {charges.isLoading ? (
            <TableSkeleton rows={6} columns={6} />
          ) : charges.isError ? (
            <ApiState error={charges.error} onRetry={() => void charges.refetch()} />
          ) : (
            <ChargesTable
              charges={charges.data?.rows ?? []}
              rangeDays={rangeDays}
              onRangeDaysChange={setRangeDays}
              truncated={charges.data?.truncated === true}
            />
          )}
        </>
      )}
    </ScreenScrollView>
  );
}
