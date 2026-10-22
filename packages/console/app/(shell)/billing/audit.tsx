import { Button } from '@oxy.so/bloom/button';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { PageBody } from '@/components/account-pages/PageFrame';
import { MonoCell, NumberCell, TextCell } from '@/components/account-pages/cells';
import { Muted, Section } from '@/components/account-pages/Section';
import { SkeletonRows } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { useReportLabels } from '@/components/billing/labels';
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
        cell: ({ row }) => <TextCell muted>{new Date(row.createdAt).toLocaleString()}</TextCell>,
      },
      {
        id: 'change',
        header: t('billingPage.audit.change'),
        minWidth: 220,
        cell: ({ row }) => (
          <View className="items-start gap-1">
            {/* The API's own token, which is the word a support conversation
                quotes, with the meaning beside it. */}
            <StatusBadge variant="outline" label={humaniseAuditToken(row.kind)} />
            <Text className="text-xs text-muted-foreground">{labels.billingKind(row.kind)}</Text>
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
                <Text className="text-xs text-muted-foreground">—</Text>
              ) : (
                references.map((reference) => (
                  <Text key={reference.id} className="font-mono text-xs text-foreground">
                    <Text className="text-muted-foreground">
                      {labels.billingReference(reference.label)}{' '}
                    </Text>
                    {reference.id}
                  </Text>
                ))
              )}
              <MonoCell muted>{t('billingPage.audit.entry', { id: row.id })}</MonoCell>
            </View>
          );
        },
      },
      {
        id: 'author',
        header: t('billingPage.audit.author'),
        width: 160,
        cell: ({ row }) => <TextCell muted>{labels.billingActor(row.actorKind)}</TextCell>,
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
            <NumberCell
              muted={direction.tone === 'neutral'}
              tone={direction.tone === 'negative' ? 'negative' : 'default'}
              // The words, for a screen reader: the sign alone is not one.
              accessibilityLabel={`${billingAuditAmount(row)} ${labels.billingDirection(row.direction)}`}
            >
              {billingAuditAmount(row)}
            </NumberCell>
          );
        },
      },
    ],
    [t, labels],
  );

  if (refused) {
    return (
      <PageBody>
        <AuditRefusal missing={['billing:read']} what={t('billingPage.audit.what')} />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <Section description={t('billingPage.audit.body')} last>
        <ProvenanceBanner
          provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
        />

        {query.isLoading ? (
          <SkeletonRows />
        ) : query.isError ? (
          <Muted>{t('billingPage.audit.loadFailed')}</Muted>
        ) : entries.length === 0 ? (
          <Muted>{t('billingPage.audit.empty')}</Muted>
        ) : (
          <>
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
          </>
        )}
      </Section>
    </PageBody>
  );
}
