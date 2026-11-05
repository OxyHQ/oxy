import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { ApiState } from '@/components/loading/ApiState';
import { TableSkeleton } from '@/components/loading/ContentSkeleton';
import { useAccount } from '@/hooks/use-account';
import { type AccountAuditEntry, useAccountAuditTrail } from '@/hooks/use-account-audit';
import {
  ACCOUNT_AUDIT_PERMISSIONS,
  accountAuditAccess,
  accountAuditActorUserId,
  accountAuditVariant,
} from '@/lib/account-audit';
import { isPermissionRefused } from '@/lib/api-error';
import { humaniseAuditToken } from '@/lib/credential-audit';
import { useTranslation } from '@/lib/i18n';

/**
 * What changed on this account, and who did it: the union of the credential and provider
 * connection event tables in ONE server-computed order (`GET /accounts/:id/audit`).
 *
 *  1. The actor is a discriminated union; `lib/account-audit.ts` reads the discriminant.
 *  2. The cursor is opaque: arrival order IS the server's order, never re-sorted here.
 *  3. A refusal is a refusal: the route needs two permissions and declines rather than
 *     narrowing, so does this page (before the request, and if the server refuses it).
 */
export function AuditPage() {
  const { t } = useTranslation();
  const { currentAccount } = useAccount();
  const access = currentAccount === null ? null : accountAuditAccess(currentAccount);
  const query = useAccountAuditTrail(currentAccount?.accountId, access?.kind === 'permitted');
  const entries = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data],
  );

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
              tone={accountAuditVariant(row) === 'destructive' ? 'danger' : 'neutral'}
              appearance={accountAuditVariant(row) === 'destructive' ? 'subtle' : 'outline'}
              size="label-small"
            />
            {/* Only a refused validation carries a reason. */}
            {row.reason !== null && (
              <Badge
                content={humaniseAuditToken(row.reason)}
                tone="neutral"
                appearance="plain"
                size="label-small"
              />
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
            <Muted>{t(`settingsPage.audit.sources.${row.source}`)}</Muted>
            <Text className="font-mono text-xs">{row.subjectId}</Text>
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
              <Muted>{t(`settingsPage.audit.actors.${row.actor.kind}`)}</Muted>
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
    [t],
  );

  const what = t('settingsPage.audit.what');

  if (access === null || query.isLoading) {
    return <TableSkeleton rows={6} columns={4} />;
  }
  if (access.kind === 'refused') {
    return <AuditRefusal missing={access.missing} what={what} />;
  }
  // The membership changed under the page: same words, from the same rule.
  if (query.isError && isPermissionRefused(query.error)) {
    return <AuditRefusal missing={ACCOUNT_AUDIT_PERMISSIONS} what={what} />;
  }
  if (query.isError) {
    return <ApiState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (entries.length === 0) {
    return <EmptyState variant="compact" title={t('settingsPage.audit.empty')} />;
  }

  return (
    <View className="gap-4">
      <DataTable
        rows={entries}
        columns={columns}
        getRowId={(row, index) =>
          `${row.source}-${row.subjectId}-${row.eventType}-${row.createdAt}-${index}`
        }
        accessibilityLabel={t('settingsPage.audit.tableLabel')}
        minWidth={820}
        bordered={false}
      />
      {query.hasNextPage && (
        <View className="items-start">
          <Button
            appearance="plain"
            size="sm"
            loading={query.isFetchingNextPage}
            onPress={() => void query.fetchNextPage()}
          >
            {t('settingsPage.audit.loadOlder')}
          </Button>
        </View>
      )}
    </View>
  );
}
