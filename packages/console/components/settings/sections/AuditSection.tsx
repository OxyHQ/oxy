import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { statusBadge, useReportLabels } from '@/components/billing/labels';
import { useAccount } from '@/hooks/use-account';
import { type AccountAuditEntry, useAccountAuditTrail } from '@/hooks/use-account-audit';
import { isPermissionRefused } from '@/lib/api-error';
import {
  ACCOUNT_AUDIT_PERMISSIONS,
  accountAuditAccess,
  accountAuditActorUserId,
  accountAuditVariant,
} from '@/lib/account-audit';
import { humaniseAuditToken } from '@/lib/credential-audit';
import { useTranslation } from '@/lib/i18n';

/**
 * What changed on this account, and who did it (issue #972).
 *
 * The union of the two audit event tables — application credentials and BYOK
 * provider connections — in ONE order, newest first. Both underlying reads are
 * per-entity, so assembling this client-side would be an unbounded fan-out
 * producing an aggregate that never existed; `GET /accounts/:id/audit` computes
 * it where the rows live and this page renders exactly what it sends.
 *
 * Three API decisions this page does not undo:
 *
 *  1. **The actor is a discriminated union**, and each arm says something
 *     different. `lib/account-audit.ts` reads the discriminant and never asks
 *     whether an id is present — three of the five arms have none.
 *  2. **The cursor is opaque and compound.** `hooks/use-account-audit.ts` hands
 *     the server's own cursor back verbatim and this page never re-sorts a page
 *     after fetching it: arrival order IS the server's order.
 *  3. **A refusal is a refusal.** The route demands both `credentials:read` and
 *     `inference:providers:read` and refuses rather than narrowing; so does this
 *     page, before the request and again if the server refuses it.
 */
export function AuditSection() {
  const { t } = useTranslation();
  const labels = useReportLabels();
  const { currentAccount } = useAccount();
  const access = currentAccount === null ? null : accountAuditAccess(currentAccount);

  const query = useAccountAuditTrail(currentAccount?.accountId, access?.kind === 'permitted');

  // Arrival order, flattened. Never sorted, sliced or de-duplicated here: the
  // order across the two sources is a single `order by` in one SQL statement,
  // and a comparator on this side would be a second definition of it.
  const entries = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data],
  );

  const serverRefused = query.isError && isPermissionRefused(query.error);

  const columns = useMemo<ReadonlyArray<DataTableColumn<AccountAuditEntry>>>(
    () => [
      {
        id: 'when',
        header: t('settingsPage.audit.when'),
        minWidth: 170,
        cell: ({ row }) => <Muted>{new Date(row.createdAt).toLocaleString()}</Muted>,
      },
      {
        id: 'change',
        header: t('settingsPage.audit.change'),
        minWidth: 200,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Badge
              content={humaniseAuditToken(row.eventType)}
              {...statusBadge(accountAuditVariant(row))}
            />
            {/* Only a refused validation carries a reason. */}
            {row.reason !== null && (
              <Badge content={humaniseAuditToken(row.reason)} {...statusBadge('ghost')} />
            )}
          </View>
        ),
      },
      {
        id: 'subject',
        header: t('settingsPage.audit.subject'),
        minWidth: 200,
        cell: ({ row }) => (
          <View className="gap-0.5">
            <Muted>{labels.auditSource(row.source)}</Muted>
            <Text className="font-mono text-xs">{row.subjectId}</Text>
            {/* An application only for a credential event; a connection has none. */}
            {row.applicationId !== null && (
              <Muted className="font-mono text-xs">
                {t('settingsPage.audit.app', { id: row.applicationId })}
              </Muted>
            )}
          </View>
        ),
      },
      {
        id: 'who',
        header: t('settingsPage.audit.who'),
        minWidth: 180,
        cell: ({ row }) => {
          const actorUserId = accountAuditActorUserId(row);
          return (
            <View className="gap-0.5">
              <Muted>{labels.auditActor(row.actor.kind)}</Muted>
              {actorUserId !== null && <Muted className="font-mono text-xs">{actorUserId}</Muted>}
            </View>
          );
        },
      },
      {
        id: 'environment',
        header: t('settingsPage.audit.environment'),
        width: 150,
        cell: ({ row }) => (
          <Muted>{row.environment ?? t('settingsPage.audit.noEnvironment')}</Muted>
        ),
      },
    ],
    [t, labels],
  );

  const what = t('settingsPage.audit.what');

  return (
    <View className="gap-4">
      {access === null ? (
        <Skeleton.Box width="100%" height={64} />
      ) : access.kind === 'refused' ? (
        <AuditRefusal missing={access.missing} what={what} />
      ) : serverRefused ? (
        // The membership changed under the page, or a permission was revoked
        // between the switcher and this read. Same words, from the same rule.
        <AuditRefusal missing={ACCOUNT_AUDIT_PERMISSIONS} what={what} />
      ) : query.isLoading ? (
        <Skeleton.Box width="100%" height={176} />
      ) : query.isError ? (
        <Muted>{t('settingsPage.audit.loadFailed')}</Muted>
      ) : entries.length === 0 ? (
        <EmptyState variant="compact" title={t('settingsPage.audit.empty')} />
      ) : (
        <>
          <DataTable
            rows={entries}
            columns={columns}
            getRowId={(row, index) =>
              `${row.source}-${row.subjectId}-${row.eventType}-${row.createdAt}-${index}`
            }
            accessibilityLabel={t('settingsPage.audit.tableLabel')}
            minWidth={820}
          />
          {query.hasNextPage && (
            <View className="items-start">
              <Button
                appearance="plain"
                size="sm"
                onPress={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? t('common.loading') : t('settingsPage.audit.loadOlder')}
              </Button>
            </View>
          )}
        </>
      )}
    </View>
  );
}
