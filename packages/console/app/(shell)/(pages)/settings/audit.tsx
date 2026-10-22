import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { useMemo } from 'react';
import { View } from 'react-native';
import { PageFrame } from '@/components/account-pages/PageFrame';
import { MonoCell, TextCell } from '@/components/account-pages/cells';
import { Muted } from '@/components/account-pages/Section';
import { SkeletonRows } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { useReportLabels } from '@/components/billing/labels';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { accountLabel, useAccount } from '@/hooks/use-account';
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
export default function AccountAuditPage() {
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
        cell: ({ row }) => <TextCell muted>{new Date(row.createdAt).toLocaleString()}</TextCell>,
      },
      {
        id: 'change',
        header: t('settingsPage.audit.change'),
        minWidth: 200,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <StatusBadge
              variant={accountAuditVariant(row)}
              label={humaniseAuditToken(row.eventType)}
            />
            {/* Only a refused validation carries a reason. */}
            {row.reason !== null && (
              <StatusBadge variant="ghost" label={humaniseAuditToken(row.reason)} />
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
            <TextCell muted>{labels.auditSource(row.source)}</TextCell>
            <MonoCell>{row.subjectId}</MonoCell>
            {/* An application only for a credential event; a connection has none. */}
            {row.applicationId !== null && (
              <MonoCell muted>{t('settingsPage.audit.app', { id: row.applicationId })}</MonoCell>
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
              <TextCell muted>{labels.auditActor(row.actor.kind)}</TextCell>
              {actorUserId !== null && <MonoCell muted>{actorUserId}</MonoCell>}
            </View>
          );
        },
      },
      {
        id: 'environment',
        header: t('settingsPage.audit.environment'),
        width: 150,
        cell: ({ row }) => (
          <TextCell muted>{row.environment ?? t('settingsPage.audit.noEnvironment')}</TextCell>
        ),
      },
    ],
    [t, labels],
  );

  const what = t('settingsPage.audit.what');

  return (
    <PageFrame
      title={t('settingsPage.audit.title')}
      subtitle={
        currentAccount === null
          ? t('settingsPage.audit.subtitleNone')
          : t('settingsPage.audit.subtitle', { name: accountLabel(currentAccount) })
      }
      headerExtra={<SettingsTabs active="audit" />}
    >
      {access === null ? (
        <View className="px-6 py-8">
          <SkeletonRows count={1} height={64} />
        </View>
      ) : access.kind === 'refused' ? (
        <AuditRefusal missing={access.missing} what={what} />
      ) : serverRefused ? (
        // The membership changed under the page, or a permission was revoked
        // between the switcher and this read. Same words, from the same rule.
        <AuditRefusal missing={ACCOUNT_AUDIT_PERMISSIONS} what={what} />
      ) : query.isLoading ? (
        <View className="px-6 py-6">
          <SkeletonRows />
        </View>
      ) : query.isError ? (
        <View className="px-6 py-8">
          <Muted>{t('settingsPage.audit.loadFailed')}</Muted>
        </View>
      ) : entries.length === 0 ? (
        <View className="px-6 py-8">
          <Muted>{t('settingsPage.audit.empty')}</Muted>
        </View>
      ) : (
        <View className="gap-4 px-6 py-6">
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
        </View>
      )}
    </PageFrame>
  );
}
