import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import type { LedgerBalanceBucket, LedgerBalanceResponse } from '@/lib/reporting';
import { ProvenanceBadge } from './provenance-banner';
import { statusBadge } from './labels';

/**
 * What the account holds, with the buckets kept apart.
 *
 * There is no total on purpose: purchased, promotional and reserved money are
 * three different things (promotional may expire and is never refundable;
 * reserved is HELD against requests in flight). Adding them gives a figure that
 * is wrong for every question anyone asks of it. `Available to spend` sits
 * BESIDE the three as the server's derived headroom.
 *
 * Every amount arrives as an exact decimal string and is formatted as a string
 * (`lib/money.ts`); nothing here goes through `Number()`.
 */
export function AccountBalanceCard({
  balance,
  isLoading,
}: {
  balance: LedgerBalanceResponse | undefined;
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return <Skeleton.Box width="100%" height={176} />;
  }

  if (balance === undefined) {
    return <Muted>{t('billingPage.balance.unavailable')}</Muted>;
  }

  if (!balance.provisioned) {
    return (
      <EmptyState
        variant="compact"
        icon={RiBankCardLine}
        title={t('billingPage.balance.noProfileTitle')}
        description={t('billingPage.balance.noProfileBody')}
      />
    );
  }

  if (balance.balances.length === 0) {
    return <Admonition type="info">{t('billingPage.balance.empty')}</Admonition>;
  }

  return (
    <View className="gap-6">
      {balance.balances.map((bucket) => (
        <CurrencyBalance
          key={bucket.currency}
          bucket={bucket}
          billingMode={balance.billingMode}
          creditLimit={balance.creditLimit}
        />
      ))}
    </View>
  );
}

function CurrencyBalance({
  bucket,
  billingMode,
  creditLimit,
}: {
  bucket: LedgerBalanceBucket;
  billingMode: 'prepaid' | 'invoiced' | undefined;
  creditLimit: string | undefined;
}) {
  const { t } = useTranslation();
  const money = (amount: string) => formatMoney(amount, bucket.currency);

  return (
    <GroupedSection title={bucket.currency}>
      <GroupedSectionItem
        title={t('billingPage.balance.purchased')}
        description={t('billingPage.balance.purchasedHint')}
        value={money(bucket.purchased)}
      />
      <GroupedSectionItem
        title={t('billingPage.balance.promotional')}
        description={t('billingPage.balance.promotionalHint')}
        value={money(bucket.promotional)}
      />
      <GroupedSectionItem
        title={t('billingPage.balance.reserved')}
        description={t('billingPage.balance.reservedHint')}
        value={money(bucket.reserved)}
      />
      <GroupedSectionItem
        title={t('billingPage.balance.available')}
        description={t('billingPage.balance.availableHint')}
        value={money(bucket.availableToSpend)}
        rightElement={
          <View className="flex-row items-center gap-2">
            {billingMode !== undefined && (
              <Badge
                content={t(
                  billingMode === 'prepaid'
                    ? 'billingPage.mode.prepaid'
                    : 'billingPage.mode.invoiced',
                )}
                {...statusBadge('default')}
              />
            )}
            <ProvenanceBadge
              provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
            />
          </View>
        }
      />
      {billingMode === 'invoiced' && (
        <GroupedSectionItem
          title={t('billingPage.balance.invoicedOutstanding')}
          description={t('billingPage.balance.invoicedOutstandingHint')}
          value={money(bucket.invoicedOutstanding)}
        />
      )}
      {billingMode === 'invoiced' && creditLimit !== undefined && (
        <GroupedSectionItem
          title={t('billingPage.balance.creditLimit')}
          description={t('billingPage.balance.creditLimitHint')}
          value={money(creditLimit)}
        />
      )}
    </GroupedSection>
  );
}
