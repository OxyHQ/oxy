import React, { useCallback, useMemo } from 'react';
import { Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { Subscription } from '@oxy.so/services';
import { useOxy } from '@oxy.so/services';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { formatDate } from '@/utils/date-utils';

interface SubscriptionCardProps {
  /** Current subscription, or `null` while it has not loaded / errored. */
  subscription: Subscription | null;
}

/**
 * "Subscription" section: shows the active plan, its status / next billing
 * date, and a manage / upgrade CTA that opens the PremiumSubscription bottom
 * sheet.
 */
export function SubscriptionCard({ subscription }: SubscriptionCardProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const { showBottomSheet } = useOxy();

  const getPlanName = useCallback((plan: string): string => {
    const key = `payments.subscription.plans.${plan}`;
    const translated = t(key);
    if (translated !== key) return translated;
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }, [t]);

  const getSubscriptionStatus = useCallback((sub: Subscription | null): string => {
    if (!sub || sub.plan === 'basic') {
      return t('payments.subscription.noActive');
    }
    if (sub.status === 'canceled') {
      return t('payments.subscription.canceled');
    }
    if (sub.status === 'expired') {
      return t('payments.subscription.expired');
    }
    if (sub.endDate) {
      const endDate = new Date(sub.endDate);
      const now = new Date();
      if (endDate < now) {
        return t('payments.subscription.expired');
      }
      return t('payments.subscription.renews', { date: formatDate(sub.endDate) });
    }
    return t('payments.subscription.active');
  }, [t]);

  const getNextBillingDate = useCallback((sub: Subscription | null): string | null => {
    if (!sub || sub.plan === 'basic' || sub.status !== 'active') {
      return null;
    }
    if (sub.endDate) {
      return formatDate(sub.endDate);
    }
    return null;
  }, []);

  const handleManageSubscription = useCallback(() => {
    showBottomSheet?.('PremiumSubscription');
  }, [showBottomSheet]);

  const isActivePaidPlan = subscription?.plan !== 'basic' && subscription?.status === 'active';

  const items = useMemo(() => {
    const planName = subscription ? getPlanName(subscription.plan) : t('payments.subscription.plans.basic');
    const status = subscription ? getSubscriptionStatus(subscription) : t('payments.subscription.noActive');
    const nextBilling = subscription ? getNextBillingDate(subscription) : null;

    return [{
      id: 'subscription',
      icon: 'credit-card-outline',
      iconColor: isActivePaidPlan ? colors.success : colors.sidebarIconPayments,
      title: planName,
      subtitle: isActivePaidPlan
        ? nextBilling
          ? t('payments.subscription.nextBilling', { date: nextBilling })
          : status
        : t('payments.subscription.upgrade'),
      customContent: (
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.card }]}
          onPress={handleManageSubscription}
          accessibilityRole="button"
          accessibilityLabel={subscription?.plan !== 'basic' ? t('a11y.manageSubscription') : t('a11y.upgradeSubscription')}
        >
          <Text style={[styles.buttonText, { color: colors.text }]}>
            {subscription?.plan !== 'basic' ? t('payments.subscription.manage') : t('payments.subscription.upgradeCta')}
          </Text>
        </TouchableOpacity>
      ),
    }];
  }, [subscription, colors, isActivePaidPlan, getPlanName, getSubscriptionStatus, getNextBillingDate, handleManageSubscription, t]);

  return (
    <Section title={t('payments.sections.subscription')}>
      <AccountCard>
        <GroupedSection items={items} />
      </AccountCard>
    </Section>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
