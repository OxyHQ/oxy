import { ScreenScrollView } from '@oxy.so/bloom/screen';
import { useMemo } from 'react';

import { BillingAuditTable } from '@/components/billing/BillingAuditTable';
import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { NoBillingAccess } from '@/components/reporting/NoBillingAccess';
import { ProvenanceBanner } from '@/components/reporting/ProvenanceBanner';
import { useAccountBillingAudit } from '@/hooks/use-account-audit';
import { useBillingAccess } from '@/hooks/use-billing-access';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * What changed about this account's money: funds added, credit granted, charges
 * reversed, invoices paid. The other ledger entry kinds are internal and the API
 * withholds them; per-request settlements are on Holds and charges.
 *
 * The API sends `actorKind` without an actor id, on purpose: a customer auditing a
 * surprise credit needs to know whether a person did it, and the employee's name
 * is not theirs to have.
 */
export default function BillingAuditPage() {
  const { accountId, canRead } = useBillingAccess();
  const audit = useAccountBillingAudit(accountId, canRead);

  // Arrival order, flattened: the server's `(created_at desc, id desc)` keyset.
  const entries = useMemo(
    () => (audit.data?.pages ?? []).flatMap((page) => page.data),
    [audit.data],
  );

  return (
    <ScreenScrollView contentContainerClassName="gap-4 p-4 pb-12">
      {!canRead ? (
        <NoBillingAccess />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />
          {audit.isLoading ? (
            <TableSkeleton rows={6} columns={5} />
          ) : audit.isError ? (
            <ApiState error={audit.error} onRetry={() => void audit.refetch()} />
          ) : (
            <BillingAuditTable
              entries={entries}
              hasMore={audit.hasNextPage}
              isLoadingMore={audit.isFetchingNextPage}
              onLoadMore={() => void audit.fetchNextPage()}
            />
          )}
        </>
      )}
    </ScreenScrollView>
  );
}
