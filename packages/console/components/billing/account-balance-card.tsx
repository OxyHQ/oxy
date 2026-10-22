import { Text, View } from 'react-native';
import { Figure, FigureRow, Muted, Panel } from '@/components/account-pages/Section';
import { SkeletonFigures } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import type { LedgerBalanceBucket, LedgerBalanceResponse } from '@/lib/reporting';
import { ProvenanceBadge } from './provenance-banner';

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
    return <SkeletonFigures />;
  }

  if (balance === undefined) {
    return <Muted>{t('billingPage.balance.unavailable')}</Muted>;
  }

  if (!balance.provisioned) {
    return (
      <Panel dashed>
        <Text className="text-sm font-medium text-foreground">
          {t('billingPage.balance.noProfileTitle')}
        </Text>
        <Muted>{t('billingPage.balance.noProfileBody')}</Muted>
      </Panel>
    );
  }

  if (balance.balances.length === 0) {
    return <Muted>{t('billingPage.balance.empty')}</Muted>;
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
    <View className="gap-4">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-sm font-semibold text-foreground">{bucket.currency}</Text>
        {billingMode !== undefined && (
          <StatusBadge
            label={t(
              billingMode === 'prepaid' ? 'billingPage.mode.prepaid' : 'billingPage.mode.invoiced',
            )}
          />
        )}
        <ProvenanceBadge
          provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
        />
      </View>

      <FigureRow>
        <Figure
          label={t('billingPage.balance.purchased')}
          hint={t('billingPage.balance.purchasedHint')}
          value={money(bucket.purchased)}
        />
        <Figure
          label={t('billingPage.balance.promotional')}
          hint={t('billingPage.balance.promotionalHint')}
          value={money(bucket.promotional)}
        />
        <Figure
          label={t('billingPage.balance.reserved')}
          hint={t('billingPage.balance.reservedHint')}
          value={money(bucket.reserved)}
        />
        <Figure
          label={t('billingPage.balance.available')}
          hint={t('billingPage.balance.availableHint')}
          value={money(bucket.availableToSpend)}
        />
      </FigureRow>

      {billingMode === 'invoiced' && (
        <FigureRow>
          <Figure
            label={t('billingPage.balance.invoicedOutstanding')}
            hint={t('billingPage.balance.invoicedOutstandingHint')}
            value={money(bucket.invoicedOutstanding)}
          />
          {creditLimit !== undefined && (
            <Figure
              label={t('billingPage.balance.creditLimit')}
              hint={t('billingPage.balance.creditLimitHint')}
              value={money(creditLimit)}
            />
          )}
        </FigureRow>
      )}
    </View>
  );
}
