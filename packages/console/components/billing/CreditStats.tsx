import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { RiGiftLine } from '@oxy.so/bloom/icons/RiGiftLine';
import { RiWallet3Line } from '@oxy.so/bloom/icons/RiWallet3Line';
import { StatCards } from '@oxy.so/bloom/stat-cards';
import { UsageCard } from '@oxy.so/bloom/usage-card';
import { View } from 'react-native';

import type { Credits } from '@/hooks/use-billing';
import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The signed-in user's API credits: totals, and how much of today's free refresh is
 * left. Credits are a unit of their own, never added to inference money.
 */
export function CreditStats({ credits, planName }: { credits: Credits; planName: string }) {
  const { t } = useTranslation();

  const used =
    credits.dailyRefresh > 0
      ? Math.min(Math.max(1 - credits.freeCredits / credits.dailyRefresh, 0), 1)
      : 0;
  const resets =
    credits.lastRefresh === null
      ? t('billingPage.plans.resetsDaily')
      : t('billingPage.plans.resetsAt', {
          when: new Date(Date.parse(credits.lastRefresh) + DAY_MS).toLocaleString(),
        });

  return (
    <View className="gap-4 xl:flex-row xl:items-start">
      <View className="min-w-0 xl:flex-[2]">
        <StatCards
          columns={2}
          stats={[
            {
              icon: RiWallet3Line,
              label: t('billingPage.plans.totalCredits'),
              value: formatCount(credits.credits),
              delta: t('billingPage.plans.creditsUnit'),
              deltaColor: 'neutral',
            },
            {
              icon: RiGiftLine,
              label: t('billingPage.plans.freeCredits'),
              value: formatCount(credits.freeCredits),
              delta: t('billingPage.plans.dailyRefresh', {
                count: formatCount(credits.dailyRefresh),
              }),
              deltaColor: 'neutral',
            },
            {
              icon: RiCoinsLine,
              label: t('billingPage.plans.paidCredits'),
              value: formatCount(credits.paidCredits),
              delta: t('billingPage.plans.creditsUnit'),
              deltaColor: 'neutral',
            },
          ]}
        />
      </View>
      <View className="min-w-0 xl:flex-1">
        <UsageCard
          plan={planName}
          limits={[{ label: t('billingPage.plans.freeToday'), used, resets }]}
        />
      </View>
    </View>
  );
}
