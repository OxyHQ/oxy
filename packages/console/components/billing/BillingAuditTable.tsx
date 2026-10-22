import { Button } from '@oxy.so/bloom/button';
import { Chip, type ChipHue } from '@oxy.so/bloom/chip';
import {
  DataTable,
  type DataTableColumn,
  DataTableFilter,
  DataTableSearch,
} from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import type { BillingAuditEntry, BillingAuditKind } from '@/hooks/use-account-audit';
import {
  billingAuditAmount,
  billingAuditDirection,
  billingAuditReferences,
} from '@/lib/billing-audit';
import { humaniseAuditToken } from '@/lib/credential-audit';
import { useDateFormat } from '@/hooks/use-date-format';
import { useTranslation } from '@/lib/i18n';

const KINDS = [
  'top_up',
  'promotional_grant',
  'settlement_reversal',
  'invoice_payment',
] as const satisfies ReadonlyArray<BillingAuditKind>;

const TONE_HUE: Record<'positive' | 'negative' | 'neutral', ChipHue> = {
  positive: 'lime',
  negative: 'rose',
  neutral: 'gray',
};

/**
 * Every customer-facing change to what the account holds, newest first, in the
 * server's order (a client-side sort would be a second, disagreeing definition of
 * it, so the columns are not sortable). The amount is a non-negative exact string
 * and the sign comes from the entry's own `direction`, never from its kind.
 */
export function BillingAuditTable({
  entries,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: {
  entries: ReadonlyArray<BillingAuditEntry>;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  const dates = useDateFormat();
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        (kind === 'all' || entry.kind === kind) &&
        (needle === '' ||
          entry.id.toLowerCase().includes(needle) ||
          billingAuditReferences(entry).some((reference) =>
            reference.id.toLowerCase().includes(needle),
          )),
    );
  }, [entries, kind, query]);

  const columns = useMemo<DataTableColumn<BillingAuditEntry>[]>(
    () => [
      {
        id: 'when',
        header: t('billingPage.audit.when'),
        flex: 1.1,
        sortable: false,
        cell: ({ row }) => <Muted>{dates.dateTime(row.createdAt)}</Muted>,
      },
      {
        id: 'change',
        header: t('billingPage.audit.change'),
        flex: 1.6,
        sortable: false,
        cell: ({ row }) => (
          <View className="items-start gap-1">
            {/* The API's own token is the word a support conversation quotes. */}
            <Chip size="md" hue="neutral">
              {humaniseAuditToken(row.kind)}
            </Chip>
            <Muted className="text-xs text-muted-foreground">
              {t(`billingPage.audit.kinds.${row.kind}`)}
            </Muted>
          </View>
        ),
      },
      {
        id: 'reference',
        header: t('billingPage.audit.reference'),
        flex: 1.4,
        sortable: false,
        cell: ({ row }) => {
          const references = billingAuditReferences(row);
          return (
            <View className="gap-0.5">
              {references.map((reference) => (
                <Text key={reference.id} className="font-mono text-xs" numberOfLines={1}>
                  <Muted className="text-xs text-muted-foreground">
                    {t(`billingPage.audit.references.${reference.label}`)}{' '}
                  </Muted>
                  {reference.id}
                </Text>
              ))}
              <Muted className="font-mono text-xs text-muted-foreground" numberOfLines={1}>
                {t('billingPage.audit.entry', { id: row.id })}
              </Muted>
            </View>
          );
        },
      },
      {
        id: 'author',
        header: t('billingPage.audit.author'),
        sortable: false,
        cell: ({ row }) => <Muted>{t(`billingPage.audit.actors.${row.actorKind}`)}</Muted>,
      },
      {
        id: 'amount',
        header: t('billingPage.audit.amount'),
        align: 'end',
        sortable: false,
        cell: ({ row }) => (
          <Chip
            size="lg"
            hue={TONE_HUE[billingAuditDirection(row).tone]}
            // The words, for a screen reader: the sign alone is not one.
            accessibilityLabel={`${billingAuditAmount(row)} ${t(`billingPage.audit.directions.${row.direction}`)}`}
          >
            {billingAuditAmount(row)}
          </Chip>
        ),
      },
    ],
    [dates, t],
  );

  return (
    <View className="gap-3">
      <DataTable
        layout="inset"
        accessibilityLabel={t('billingPage.audit.tableLabel')}
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        title={t('billingPage.audit.title')}
        summary={t('billingPage.audit.summary', { count: rows.length })}
        toolbar={
          <>
            <DataTableFilter
              label={t('billingPage.audit.change')}
              value={kind}
              onValueChange={(next) => {
                setKind(next);
                setPage(1);
              }}
              options={[
                { value: 'all', label: t('billingPage.audit.allKinds') },
                ...KINDS.map((value) => ({ value, label: humaniseAuditToken(value) })),
              ]}
            />
            <DataTableSearch
              label={t('billingPage.audit.search')}
              value={query}
              onValueChange={(next) => {
                setQuery(next);
                setPage(1);
              }}
            />
          </>
        }
        page={page}
        onPageChange={setPage}
        pageSize={10}
        minWidth={820}
        emptyState={
          <EmptyState variant="compact" icon={RiHistoryLine} title={t('billingPage.audit.empty')} />
        }
      />
      {hasMore ? (
        <View className="items-start px-3">
          <Button appearance="outline" size="sm" loading={isLoadingMore} onPress={onLoadMore}>
            {t('billingPage.audit.loadOlder')}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
