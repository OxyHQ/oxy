import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { SubscriptionPlans } from '@oxy.so/bloom/subscription-plans';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';

import { type SubscriptionPlan, useCreateSubscriptionCheckout } from '@/hooks/use-billing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';

/**
 * Choose an API-credit plan and continue to the provider's hosted checkout.
 *
 * Bloom's `SubscriptionPlans` is the selector; the checkout itself, the price and
 * the credits per month all come from the plan the API serves.
 */
export function PlanPicker({ plans }: { plans: ReadonlyArray<SubscriptionPlan> }) {
  const { t } = useTranslation();
  const checkout = useCreateSubscriptionCheckout();
  const [selected, setSelected] = useState(plans[0]?.id ?? '');

  if (plans.length === 0) {
    return (
      <EmptyState variant="compact" icon={RiCoinsLine} title={t('billingPage.plans.noPlans')} />
    );
  }

  const subscribe = async () => {
    try {
      const result = await checkout.mutateAsync({
        planId: selected,
        successUrl: `${window.location.origin}/billing/plans?success=true`,
        cancelUrl: `${window.location.origin}/billing/plans?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.plans.subscriptionCheckoutFailed')));
    }
  };

  return (
    <SubscriptionPlans
      productName={t('billingPage.plans.creditPlans')}
      selectorLabel={t('billingPage.plans.chooseCreditPlan')}
      value={selected}
      onValueChange={setSelected}
      plans={plans.map((plan) => ({
        id: plan.id,
        label: plan.name,
        price: {
          amount: plan.price / 100,
          currency: plan.currency.toUpperCase(),
          suffix: t('billingPage.plans.perMonth'),
        },
        benefits: [
          {
            id: 'credits',
            title: t('billingPage.plans.planCredits', {
              credits: formatCount(plan.creditsPerMonth),
            }),
          },
        ],
      }))}
      primaryAction={{
        label: t('billingPage.plans.subscribe'),
        onPress: () => void subscribe(),
        loading: checkout.isPending,
      }}
    />
  );
}
