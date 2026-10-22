import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardHeader } from '@oxy.so/bloom/card';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { statusBadge, useReportLabels } from '@/components/billing/labels';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { useAccount } from '@/hooks/use-account';
import { type BillingAuditEntry, useAccountBillingAudit } from '@/hooks/use-account-audit';
import { isPermissionRefused } from '@/lib/api-error';
import {
  billingAuditAmount,
  billingAuditDirection,
  billingAuditReferences,
} from '@/lib/billing-audit';
import { humaniseAuditToken } from '@/lib/credential-audit';
import { useTranslation } from '@/lib/i18n';

/**
 * What changed about this account's money (issue #972).
 *
 * The customer-facing projection of the billing ledger: funds added, credit
 * granted, charges reversed, invoices paid. The other five entry kinds are
 * internal and the API withholds them. Per-request settlements are on "Holds and
 * charges", which reads the same ledger from the other end.
 *
 * Two API decisions this page does not undo:
 *
 *  1. **The amount is a non-negative exact decimal STRING, the sign a separate
 *     `direction` field.** A signed amount is how a reversal silently becomes a
 *     second charge. Every figure goes through `lib/billing-audit.ts` into
 *     `lib/money.ts`; no amount passes through a JS `number`.
 *  2. **`actorKind` without an actor id.** A customer auditing a surprise credit
 *     needs to know a person did it rather than a process; the employee's name is
 *     not theirs to have, and the API does not send it.
 */
export default function BillingAuditPage() {
  const { t } = useTranslation();
  const labels = useReportLabels();
  const { currentAccount, canReadBilling } = useAccount();
  const canRead = currentAccount !== null && canReadBilling(currentAccount);

  const query = useAccountBillingAudit(currentAccount?.accountId, canRead);

  // Arrival order, flattened — the server's `(created_at desc, id desc)` keyset,
  // which a client-side sort would be a second, disagreeing definition of.
  const entries = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data],
  );

  const refused = !canRead || (query.isError && isPermissionRefused(query.error));

  const columns = useMemo<ReadonlyArray<DataTableColumn<BillingAuditEntry>>>(
    () => [
      {
        id: 'when',
        header: t('billingPage.audit.when'),
        minWidth: 170,
        cell: ({ row }) => <Muted>{new Date(row.createdAt).toLocaleString()}</Muted>,
      },
      {
        id: 'change',
        header: t('billingPage.audit.change'),
        minWidth: 220,
        cell: ({ row }) => (
          <View className="items-start gap-1">
            {/* The API's own token, which is the word a support conversation
                quotes, with the meaning beside it. */}
            <Badge content={humaniseAuditToken(row.kind)} {...statusBadge('outline')} />
            <Muted className="text-xs">{labels.billingKind(row.kind)}</Muted>
          </View>
        ),
      },
      {
        id: 'reference',
        header: t('billingPage.audit.reference'),
        minWidth: 220,
        cell: ({ row }) => {
          const references = billingAuditReferences(row);
          return (
            <View className="gap-0.5">
              {references.length === 0 ? (
                <Muted className="text-xs">—</Muted>
              ) : (
                references.map((reference) => (
                  <Text key={reference.id} className="font-mono text-xs">
                    <Muted className="text-xs">{labels.billingReference(reference.label)} </Muted>
                    {reference.id}
                  </Text>
                ))
              )}
              <Muted className="font-mono text-xs">
                {t('billingPage.audit.entry', { id: row.id })}
              </Muted>
            </View>
          );
        },
      },
      {
        id: 'author',
        header: t('billingPage.audit.author'),
        width: 160,
        cell: ({ row }) => <Muted>{labels.billingActor(row.actorKind)}</Muted>,
      },
      {
        id: 'amount',
        header: t('billingPage.audit.amount'),
        align: 'end',
        width: 150,
        cell: ({ row }) => {
          const direction = billingAuditDirection(row);
          return (
            // Money tone: the direction the ledger recorded, never the entry's kind.
            <Text
              className={`tabular-nums ${
                direction.tone === 'negative'
                  ? 'text-destructive'
                  : direction.tone === 'neutral'
                    ? 'text-muted-foreground'
                    : ''
              }`}
              // The words, for a screen reader: the sign alone is not one.
              accessibilityLabel={`${billingAuditAmount(row)} ${labels.billingDirection(row.direction)}`}
            >
              {billingAuditAmount(row)}
            </Text>
          );
        },
      },
    ],
    [t, labels],
  );

  if (refused) {
    return (
      <ScreenScrollView contentContainerClassName="px-4 py-6">
        <AuditRefusal missing={['billing:read']} what={t('billingPage.audit.what')} />
      </ScreenScrollView>
    );
  }

  return (
    <ScreenScrollView contentContainerClassName="gap-6 px-4 py-6 pb-12">
      <ProvenanceBanner provenance={{ source: 'financial_ledger', consistency: 'authoritative' }} />

      <Card>
        <CardHeader>
          <CardDescription>{t('billingPage.audit.body')}</CardDescription>
        </CardHeader>
        <CardBody>
          {query.isLoading ? (
            <Skeleton.Box width="100%" height={176} />
          ) : query.isError ? (
            <Muted>{t('billingPage.audit.loadFailed')}</Muted>
          ) : entries.length === 0 ? (
            <EmptyState variant="compact" title={t('billingPage.audit.empty')} />
          ) : (
            <View className="gap-3">
              <DataTable
                rows={entries}
                columns={columns}
                getRowId={(row) => row.id}
                accessibilityLabel={t('billingPage.audit.tableLabel')}
                minWidth={880}
              />
              {query.hasNextPage && (
                <View className="items-start">
                  <Button
                    appearance="plain"
                    size="sm"
                    onPress={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage
                      ? t('common.loading')
                      : t('billingPage.audit.loadOlder')}
                  </Button>
                </View>
              )}
            </View>
          )}
        </CardBody>
      </Card>
    </ScreenScrollView>
  );
}
