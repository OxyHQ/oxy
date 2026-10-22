import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { RiGiftLine } from '@oxy.so/bloom/icons/RiGiftLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { StatBar } from '@oxy.so/bloom/stat-bar';
import { StatCards } from '@oxy.so/bloom/stat-cards';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import type { LedgerBalanceResponse } from '@/lib/reporting';
import { plotNumber } from '@/lib/reporting-charts';

/**
 * What the account holds, per currency, with the buckets kept apart.
 *
 * There is no total on purpose: purchased, promotional and held money are three
 * different things (promotional may expire and is never refundable; held is
 * authorised against requests in flight). "Available to spend" is the server's own
 * headroom, shown beside them. An invoiced account also gets its credit line.
 */
export function BalanceStats({ balance }: { balance: LedgerBalanceResponse }) {
  const { t } = useTranslation();
  const manyCurrencies = balance.balances.length > 1;

  return (
    <View className="gap-6">
      {balance.balances.map((bucket) => {
        const money = (amount: string) => formatMoney(amount, bucket.currency);
        return (
          <View key={bucket.currency} className="gap-4">
            {manyCurrencies ? <Text variant="headline-semibold">{bucket.currency}</Text> : null}
            <StatCards
              stats={[
                {
                  icon: RiBankCardLine,
                  label: t('billingPage.balance.available'),
                  value: money(bucket.availableToSpend),
                  delta: t(`billingPage.mode.${balance.billingMode ?? 'prepaid'}`),
                  deltaColor: 'neutral',
                },
                {
                  icon: RiCoinsLine,
                  label: t('billingPage.balance.purchased'),
                  value: money(bucket.purchased),
                  delta: t('billingPage.balance.chips.purchased'),
                  deltaColor: 'neutral',
                },
                {
                  icon: RiGiftLine,
                  label: t('billingPage.balance.promotional'),
                  value: money(bucket.promotional),
                  delta: t('billingPage.balance.chips.promotional'),
                  deltaColor: 'neutral',
                },
                {
                  icon: RiLockLine,
                  label: t('billingPage.balance.reserved'),
                  value: money(bucket.reserved),
                  delta: t('billingPage.balance.chips.reserved'),
                  deltaColor: 'neutral',
                },
              ]}
            />
            {balance.billingMode === 'invoiced' && balance.creditLimit !== undefined ? (
              <StatBar
                label={t('billingPage.balance.creditUsed', {
                  used: money(bucket.invoicedOutstanding),
                })}
                value={plotNumber(bucket.invoicedOutstanding)}
                max={Math.max(plotNumber(balance.creditLimit), 1)}
                minLabel={money('0')}
                maxLabel={t('billingPage.balance.creditLimitOf', {
                  limit: money(balance.creditLimit),
                })}
              />
            ) : null}
          </View>
        );
      })}
      <Muted>{t('billingPage.balance.explainer')}</Muted>
    </View>
  );
}
