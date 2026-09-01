import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { useAccountAuditTrail } from '@/hooks/use-account-audit';
import {
  ACCOUNT_AUDIT_PERMISSIONS,
  accountAuditAccess,
  accountAuditActorLabel,
  accountAuditActorUserId,
  accountAuditSourceLabel,
  accountAuditVariant,
} from '@/lib/account-audit';
import { humaniseAuditToken } from '@/lib/credential-audit';
import { isPermissionRefused } from '@/lib/api-error';

/**
 * What changed on this account, and who did it (issue #972).
 *
 * The union of the two audit event tables — application credentials and BYOK
 * provider connections — in ONE order, newest first. Both underlying reads are
 * per-entity (`…/credentials/:id/audit`, `…/provider-connections/:id/audit`), so
 * assembling this client-side would be one request per credential per
 * application plus one per connection: an unbounded fan-out producing an
 * aggregate that never existed. `GET /accounts/:id/audit` computes it where the
 * rows live, and this page renders exactly what it sends.
 *
 * Three things the API decided that this page does not undo:
 *
 *  1. **The actor is a discriminated union**, and each arm says something
 *     different. `lib/account-audit.ts` reads the discriminant and never asks
 *     whether an id is present — three of the five arms have none.
 *  2. **The cursor is opaque and compound.** Rows share an instant across the
 *     two sources, so `hooks/use-account-audit.ts` hands the server's own cursor
 *     back verbatim and this page never re-sorts a page after fetching it. The
 *     list below is rendered in arrival order, which IS the server's order.
 *  3. **A refusal is a refusal.** The route demands both `credentials:read` and
 *     `inference:providers:read` and refuses rather than narrowing; so does this
 *     page, before the request and again if the server refuses it.
 */
export const Route = createFileRoute('/_layout/settings/audit')({
  component: AccountAuditPage,
});

function AccountAuditPage() {
  const { currentAccount } = useAccount();
  const access =
    currentAccount === null
      ? null
      : accountAuditAccess(currentAccount);

  const query = useAccountAuditTrail(currentAccount?.accountId, access?.kind === 'permitted');

  // Arrival order, flattened. Never sorted, sliced or de-duplicated here: the
  // order across the two sources is a single `order by` in one SQL statement,
  // and a comparator on this side would be a second definition of it.
  const entries = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data]
  );

  const serverRefused = query.isError && isPermissionRefused(query.error);

  return (
    <ScrollArea className="flex-1 bg-background">
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Audit log</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          {currentAccount === null
            ? 'Credential and provider-connection changes, newest first.'
            : `Every credential and provider-connection change on ${accountLabel(currentAccount)}, newest first — including validations that were refused.`}
        </p>
      </div>

      {access === null ? (
        <div className="px-6 py-8">
          <Skeleton.Box width="100%" height={64} />
        </div>
      ) : access.kind === 'refused' ? (
        <AuditRefusal missing={access.missing} what="this account's audit log" />
      ) : serverRefused ? (
        // The membership changed under the page, or a permission was revoked
        // between the switcher and this read. Same words, from the same rule.
        <AuditRefusal
          missing={ACCOUNT_AUDIT_PERMISSIONS}
          what="this account's audit log"
        />
      ) : query.isLoading ? (
        <div className="space-y-2 px-6 py-6">
          {[1, 2, 3].map((row) => (
            <Skeleton.Box key={row} width="100%" height={44} />
          ))}
        </div>
      ) : query.isError ? (
        <p className="px-6 py-8 text-sm text-muted-foreground">
          The audit log could not be loaded.
        </p>
      ) : entries.length === 0 ? (
        <p className="px-6 py-8 text-sm text-muted-foreground">
          Nothing has changed on this account yet. Creating a credential or connecting a provider
          key writes the first entry.
        </p>
      ) : (
        <div className="px-6 py-6">
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-4 py-2 font-medium text-muted-foreground">When</th>
                  <th className="px-4 py-2 font-medium text-muted-foreground">Change</th>
                  <th className="px-4 py-2 font-medium text-muted-foreground">Subject</th>
                  <th className="px-4 py-2 font-medium text-muted-foreground">Who</th>
                  <th className="px-4 py-2 font-medium text-muted-foreground">Environment</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const actorUserId = accountAuditActorUserId(entry);
                  return (
                    <tr
                      key={`${entry.source}-${entry.subjectId}-${entry.eventType}-${entry.createdAt}`}
                      className="border-b border-border last:border-0 align-top"
                    >
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={accountAuditVariant(entry)} className="text-xs">
                            {humaniseAuditToken(entry.eventType)}
                          </Badge>
                          {/* Only a refused validation carries a reason. */}
                          {entry.reason !== null && (
                            <Badge variant="ghost" className="text-xs">
                              {humaniseAuditToken(entry.reason)}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <p className="text-muted-foreground">
                          {accountAuditSourceLabel(entry.source)}
                        </p>
                        <p className="font-mono text-xs text-foreground">{entry.subjectId}</p>
                        {/* An application only for a credential event; a connection has none. */}
                        {entry.applicationId !== null && (
                          <p className="font-mono text-xs text-muted-foreground">
                            app {entry.applicationId}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <p className="text-muted-foreground">{accountAuditActorLabel(entry)}</p>
                        {actorUserId !== null && (
                          <p className="font-mono text-xs text-muted-foreground">{actorUserId}</p>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {entry.environment ?? 'no environment'}
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
                {query.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
              </Button>
            </div>
          )}
        </div>
      )}
    </ScrollArea>
  );
}
