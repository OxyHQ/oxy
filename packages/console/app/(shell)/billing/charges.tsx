import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { PageBody } from '@/components/account-pages/PageFrame';
import { MonoCell, NumberCell, TextCell } from '@/components/account-pages/cells';
import { Denied, Muted, Note, Section } from '@/components/account-pages/Section';
import { SkeletonRows } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { RangePicker } from '@/components/billing/report-controls';
import { useAccount } from '@/hooks/use-account';
import { usePendingReservations, useSettledCharges } from '@/hooks/use-inference-reporting';
import { useTranslation } from '@/lib/i18n';
import { formatCount, formatMoney } from '@/lib/money';
import {
  type PendingReservation,
  type ReportRangeDays,
  type SettledCharge,
  lastCalendarDays,
} from '@/lib/reporting';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * Two lists that are deliberately not one: money HELD, and money CHARGED.
 *
 * A reservation is an authorisation taken before a request runs, sized on its
 * maximum possible cost. When the request finishes it settles for the exact
 * amount and the unused part is released. Nothing on the holds list has been
 * charged; presenting a hold as a charge makes a balance appear to drop and
 * recover on every request with no way to tell why.
 *
 * The token counts in the charges table are the RECEIPT's own units — what the
 * charge was computed from — not the telemetry rollups the Usage page reads, which
 * is why they may sit beside an amount here and nowhere else.
 */
export default function BillingChargesPage() {
  const { t } = useTranslation();
  const { currentAccount, canReadBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);

  const [rangeDays, setRangeDays] = useState<ReportRangeDays>(7);
  const range = useMemo(() => lastCalendarDays(rangeDays), [rangeDays]);

  const reservationsQuery = usePendingReservations(accountId, 100, canRead);
  const chargesQuery = useSettledCharges(accountId, range, 100, canRead);

  const held = reservationsQuery.data;
  const charges = chargesQuery.data;

  const heldColumns = useMemo<ReadonlyArray<DataTableColumn<PendingReservation>>>(
    () => [
      {
        id: 'request',
        header: t('billingPage.charges.request'),
        minWidth: 160,
        cell: ({ row }) => <MonoCell>{row.requestId}</MonoCell>,
      },
      {
        id: 'application',
        header: t('billingPage.charges.application'),
        minWidth: 160,
        cell: ({ row }) => <MonoCell muted>{row.applicationId}</MonoCell>,
      },
      {
        id: 'environment',
        header: t('billingPage.charges.environment'),
        width: 130,
        cell: ({ row }) => <TextCell muted>{row.environment}</TextCell>,
      },
      {
        id: 'expires',
        header: t('billingPage.charges.expires'),
        width: 130,
        cell: ({ row }) => (
          <TextCell muted>{new Date(row.expiresAt).toLocaleTimeString()}</TextCell>
        ),
      },
      {
        id: 'held',
        header: t('billingPage.charges.held'),
        align: 'end',
        width: 140,
        cell: ({ row }) => <NumberCell>{formatMoney(row.reservedAmount, row.currency)}</NumberCell>,
      },
    ],
    [t],
  );

  const chargeColumns = useMemo<ReadonlyArray<DataTableColumn<SettledCharge>>>(
    () => [
      {
        id: 'settled',
        header: t('billingPage.charges.settled'),
        minWidth: 170,
        cell: ({ row }) => <TextCell muted>{new Date(row.settledAt).toLocaleString()}</TextCell>,
      },
      {
        id: 'model',
        header: t('billingPage.charges.servedModel'),
        minWidth: 180,
        cell: ({ row }) => <MonoCell>{row.resolvedModelReference}</MonoCell>,
      },
      {
        id: 'provider',
        header: t('billingPage.charges.provider'),
        width: 130,
        cell: ({ row }) => <TextCell muted>{row.servingProvider}</TextCell>,
      },
      {
        id: 'outcome',
        header: t('billingPage.charges.outcome'),
        minWidth: 170,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <StatusBadge
              label={row.outcome}
              variant={row.outcome === 'completed' ? 'default' : 'secondary'}
            />
            {row.platformFeeOnly && (
              <StatusBadge label={t('billingPage.charges.feeOnly')} variant="outline" />
            )}
          </View>
        ),
      },
      {
        id: 'tokens',
        header: t('billingPage.charges.tokens'),
        align: 'end',
        width: 150,
        cell: ({ row }) => (
          <NumberCell muted>
            {formatCount(row.units.input_tokens)} / {formatCount(row.units.output_tokens)}
          </NumberCell>
        ),
      },
      {
        id: 'net',
        header: t('billingPage.charges.net'),
        align: 'end',
        width: 140,
        cell: ({ row }) => <NumberCell>{formatMoney(row.netAmount, row.currency)}</NumberCell>,
      },
    ],
    [t],
  );

  return (
    <PageBody>
      {!canRead ? (
        <Denied>{t('billingPage.charges.denied')}</Denied>
      ) : (
        <>
          <Section>
            <ProvenanceBanner provenance={LEDGER} />
          </Section>

          <Section
            title={t('billingPage.charges.heldTitle')}
            description={t('billingPage.charges.heldBody')}
          >
            {reservationsQuery.isLoading ? (
              <SkeletonRows count={1} height={64} />
            ) : held === undefined || held.rows.length === 0 ? (
              <Muted>{t('billingPage.charges.nothingHeld')}</Muted>
            ) : (
              <>
                <View className="flex-row flex-wrap gap-x-12 gap-y-4">
                  {held.totals.map((total) => (
                    <View key={total.currency} className="gap-0.5">
                      <Text
                        className="text-2xl font-semibold text-foreground"
                        style={{ fontVariant: ['tabular-nums'] }}
                      >
                        {formatMoney(total.heldAmount, total.currency)}
                      </Text>
                      <Text className="text-sm text-muted-foreground">
                        {t('billingPage.charges.heldAcross', { count: total.reservationCount })}
                      </Text>
                    </View>
                  ))}
                </View>
                <DataTable
                  rows={held.rows}
                  columns={heldColumns}
                  getRowId={(row) => row.reservationId}
                  accessibilityLabel={t('billingPage.charges.heldTable')}
                  minWidth={680}
                />
              </>
            )}
          </Section>

          <Section
            title={t('billingPage.charges.chargedTitle')}
            description={t('billingPage.charges.chargedBody')}
            action={<RangePicker value={rangeDays} onChange={setRangeDays} />}
            last
          >
            {chargesQuery.isLoading ? (
              <SkeletonRows />
            ) : charges === undefined || charges.rows.length === 0 ? (
              <Muted>
                {t('billingPage.charges.nothingCharged', { from: range.from, to: range.to })}
              </Muted>
            ) : (
              <DataTable
                rows={charges.rows}
                columns={chargeColumns}
                getRowId={(row) => row.receiptId}
                accessibilityLabel={t('billingPage.charges.chargedTable')}
                minWidth={820}
              />
            )}
            {charges?.truncated === true && <Note>{t('billingPage.charges.truncated')}</Note>}
          </Section>
        </>
      )}
    </PageBody>
  );
}
