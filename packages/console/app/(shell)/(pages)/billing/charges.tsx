import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { DataTable, type DataTableColumn } from '@oxy.so/bloom/data-table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { statusBadge } from '@/components/billing/labels';
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
        cell: ({ row }) => <Text className="font-mono text-xs">{row.requestId}</Text>,
      },
      {
        id: 'application',
        header: t('billingPage.charges.application'),
        minWidth: 160,
        cell: ({ row }) => <Muted className="font-mono text-xs">{row.applicationId}</Muted>,
      },
      {
        id: 'environment',
        header: t('billingPage.charges.environment'),
        width: 130,
        cell: ({ row }) => <Muted>{row.environment}</Muted>,
      },
      {
        id: 'expires',
        header: t('billingPage.charges.expires'),
        width: 130,
        cell: ({ row }) => <Muted>{new Date(row.expiresAt).toLocaleTimeString()}</Muted>,
      },
      {
        id: 'held',
        header: t('billingPage.charges.held'),
        align: 'end',
        width: 140,
        cell: ({ row }) => (
          <Text className="tabular-nums">{formatMoney(row.reservedAmount, row.currency)}</Text>
        ),
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
        cell: ({ row }) => <Muted>{new Date(row.settledAt).toLocaleString()}</Muted>,
      },
      {
        id: 'model',
        header: t('billingPage.charges.servedModel'),
        minWidth: 180,
        cell: ({ row }) => <Text className="font-mono text-xs">{row.resolvedModelReference}</Text>,
      },
      {
        id: 'provider',
        header: t('billingPage.charges.provider'),
        width: 130,
        cell: ({ row }) => <Muted>{row.servingProvider}</Muted>,
      },
      {
        id: 'outcome',
        header: t('billingPage.charges.outcome'),
        minWidth: 170,
        cell: ({ row }) => (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Badge
              content={row.outcome}
              {...statusBadge(row.outcome === 'completed' ? 'default' : 'secondary')}
            />
            {row.platformFeeOnly && (
              <Badge content={t('billingPage.charges.feeOnly')} {...statusBadge('outline')} />
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
          <Muted className="tabular-nums">
            {formatCount(row.units.input_tokens)} / {formatCount(row.units.output_tokens)}
          </Muted>
        ),
      },
      {
        id: 'net',
        header: t('billingPage.charges.net'),
        align: 'end',
        width: 140,
        cell: ({ row }) => (
          <Text className="tabular-nums">{formatMoney(row.netAmount, row.currency)}</Text>
        ),
      },
    ],
    [t],
  );

  return (
    <ScreenScrollView contentContainerClassName="gap-6 px-4 py-6 pb-12">
      {!canRead ? (
        <EmptyState icon={RiLockLine} title={t('billingPage.charges.denied')} />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />

          <Card>
            <CardHeader>
              <CardTitle>{t('billingPage.charges.heldTitle')}</CardTitle>
              <CardDescription>{t('billingPage.charges.heldBody')}</CardDescription>
            </CardHeader>
            <CardBody>
              {reservationsQuery.isLoading ? (
                <Skeleton.Box width="100%" height={64} />
              ) : held === undefined || held.rows.length === 0 ? (
                <Muted>{t('billingPage.charges.nothingHeld')}</Muted>
              ) : (
                <View className="gap-4">
                  <GroupedSection>
                    {held.totals.map((total) => (
                      <GroupedSectionItem
                        key={total.currency}
                        title={formatMoney(total.heldAmount, total.currency)}
                        description={t('billingPage.charges.heldAcross', {
                          count: total.reservationCount,
                        })}
                      />
                    ))}
                  </GroupedSection>
                  <DataTable
                    rows={held.rows}
                    columns={heldColumns}
                    getRowId={(row) => row.reservationId}
                    accessibilityLabel={t('billingPage.charges.heldTable')}
                    minWidth={680}
                  />
                </View>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('billingPage.charges.chargedTitle')}</CardTitle>
              <CardDescription>{t('billingPage.charges.chargedBody')}</CardDescription>
            </CardHeader>
            <CardBody>
              <View className="gap-4">
                <View className="items-start">
                  <RangePicker value={rangeDays} onChange={setRangeDays} />
                </View>
                {chargesQuery.isLoading ? (
                  <Skeleton.Box width="100%" height={132} />
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
                {charges?.truncated === true && <Muted>{t('billingPage.charges.truncated')}</Muted>}
              </View>
            </CardBody>
          </Card>
        </>
      )}
    </ScreenScrollView>
  );
}
