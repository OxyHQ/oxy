import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { BillingHeader } from '@/components/billing/billing-header';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { useAccountBillingAudit } from '@/hooks/use-account-audit';
import {
  billingAuditActorLabel,
  billingAuditAmount,
  billingAuditDirection,
  billingAuditKindDescription,
  billingAuditReferences,
} from '@/lib/billing-audit';
import { humaniseAuditToken } from '@/lib/credential-audit';
import { isPermissionRefused } from '@/lib/api-error';

/**
 * What changed about this account's money (issue #972).
 *
 * The customer-facing projection of the billing ledger: funds added, credit
 * granted, charges reversed, invoices paid. Four entry kinds — the other five
 * are internal (the reservation lifecycle, the per-request settlement, invoice
 * rounding) and the API withholds them, because a hold and its release are not
 * changes to anything the customer holds. Per-request settlements are on
 * "Holds and charges", which reads the same ledger from the other end.
 *
 * Two API decisions this page is careful not to undo:
 *
 *  1. **The amount is a non-negative exact decimal STRING, and the sign is a
 *     separate `direction` field.** The ledger carries no signed amounts by
 *     contract — a signed amount is how a reversal silently becomes a second
 *     charge. Every figure below goes through `lib/billing-audit.ts` into
 *     `lib/money.ts`, and no amount on this page passes through a JS `number`.
 *  2. **`actorKind` without an actor id.** A customer auditing a surprise credit
 *     needs to know a person did it rather than an automated process; the
 *     employee's name is not theirs to have, and the API does not send it.
 */
export const Route = createFileRoute('/_layout/billing/audit')({
  component: BillingAuditPage,
});

/** Money tone: the direction the ledger recorded, never the entry's kind. */
const TONE_CLASS = {
  positive: 'text-foreground',
  negative: 'text-destructive',
  neutral: 'text-muted-foreground',
} as const;

function BillingAuditPage() {
  const { currentAccount, canReadBilling } = useAccount();
  const canRead = currentAccount !== null && canReadBilling(currentAccount);

  const query = useAccountBillingAudit(currentAccount?.accountId, canRead);

  // Arrival order, flattened — the server's `(created_at desc, id desc)` keyset,
  // which a client-side sort would be a second, disagreeing definition of.
  const entries = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data]
  );

  const refused = !canRead || (query.isError && isPermissionRefused(query.error));

  return (
    <ScrollArea className="flex-1 bg-background">
      <BillingHeader
        active="audit"
        accountName={currentAccount === null ? undefined : accountLabel(currentAccount)}
      />

      {refused ? (
        <AuditRefusal missing={['billing:read']} what="this account's billing changes" />
      ) : (
        <div className="px-6 py-6">
          <ProvenanceBanner
            provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
          />

          <p className="mt-6 mb-4 max-w-2xl text-sm text-muted-foreground">
            Funds added, credit granted, charges reversed and invoices paid — every change to what
            this account holds, newest first. Per-request charges and the holds taken before them
            are on Holds and charges; they are movements within an ongoing balance rather than
            changes to it.
          </p>

          {query.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((row) => (
                <Skeleton.Box key={row} width="100%" height={44} />
              ))}
            </div>
          ) : query.isError ? (
            <p className="text-sm text-muted-foreground">
              The billing changes could not be loaded.
            </p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has changed about this account's balance yet.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left">
                      <th className="px-4 py-2 font-medium text-muted-foreground">When</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Change</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Reference</th>
                      <th className="px-4 py-2 font-medium text-muted-foreground">Author</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const direction = billingAuditDirection(entry);
                      const references = billingAuditReferences(entry);
                      return (
                        <tr
                          key={entry.id}
                          className="border-b border-border last:border-0 align-top"
                        >
                          <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-2">
                            {/* The API's own token, which is the word a support
                                conversation quotes, with the meaning beside it. */}
                            <Badge variant="outline" className="text-xs">
                              {humaniseAuditToken(entry.kind)}
                            </Badge>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {billingAuditKindDescription(entry.kind)}
                            </p>
                          </td>
                          <td className="px-4 py-2">
                            {references.length === 0 ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              references.map((reference) => (
                                <p key={reference.id} className="font-mono text-xs text-foreground">
                                  <span className="text-muted-foreground">{reference.label} </span>
                                  {reference.id}
                                </p>
                              ))
                            )}
                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                              entry {entry.id}
                            </p>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {billingAuditActorLabel(entry.actorKind)}
                          </td>
                          <td
                            className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${TONE_CLASS[direction.tone]}`}
                          >
                            {billingAuditAmount(entry)}
                            <span className="sr-only"> {direction.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {query.hasNextPage && (
                <div className="mt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage ? 'Loading…' : 'Load older changes'}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </ScrollArea>
  );
}
