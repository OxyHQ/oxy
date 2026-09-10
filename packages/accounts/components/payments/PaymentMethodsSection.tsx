import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Subscription } from '@oxy.so/services';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { formatFairCoinBalance } from '@/utils/payment-utils';
import type { GroupedItem } from '@/components/sections/types';

interface PaymentMethodsSectionProps {
  /** Current subscription, used to surface the saved card's payment method. */
  subscription: Subscription | null;
  /** Current FairCoin wallet balance, in FairCoin units. */
  balance: number;
}

/**
 * "Payment methods" section: lists the saved card, Oxy Pay, and FAIRWallet
 * options. Tapping a row toggles an inline details panel describing that
 * method.
 */
export function PaymentMethodsSection({ subscription, balance }: PaymentMethodsSectionProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded(prev => (prev === id ? null : id));
  }, []);

  const items = useMemo<GroupedItem[]>(() => [
    {
      id: 'card',
      icon: 'credit-card-outline',
      iconColor: colors.sidebarIconPayments,
      title: t('payments.methods.card'),
      subtitle: subscription?.paymentMethod
        ? t('payments.methods.cardWithMethod', { method: subscription.paymentMethod })
        : t('payments.methods.cardEmpty'),
      onPress: () => toggleExpanded('card'),
      showChevron: true,
    },
    {
      id: 'oxy-pay-method',
      icon: 'wallet-outline',
      iconColor: colors.sidebarIconPayments,
      title: t('payments.methods.oxyPay'),
      subtitle: t('payments.methods.oxyPaySubtitle', { balance: formatFairCoinBalance(balance) }),
      onPress: () => toggleExpanded('oxy-pay-method'),
      showChevron: true,
    },
    {
      id: 'faircoin-method',
      icon: 'qrcode-scan',
      iconColor: colors.brandFairCoinScan,
      title: t('payments.methods.fairwallet'),
      subtitle: t('payments.methods.fairwalletSubtitle'),
      onPress: () => toggleExpanded('faircoin-method'),
      showChevron: true,
    },
  ], [subscription, colors, balance, toggleExpanded, t]);

  return (
    <Section title={t('payments.sections.paymentMethods')}>
      <AccountCard>
        <GroupedSection items={items} />
      </AccountCard>
      {expanded && (
        <View style={[styles.expandedDetails, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {expanded === 'card' && (
            <>
              <Text style={[styles.expandedTitle, { color: colors.text }]}>{t('payments.methods.card')}</Text>
              <Text style={[styles.expandedBody, { color: colors.textSecondary }]}>
                {t('payments.expanded.cardBody')}
              </Text>
            </>
          )}
          {expanded === 'oxy-pay-method' && (
            <>
              <Text style={[styles.expandedTitle, { color: colors.text }]}>{t('payments.expanded.oxyPayTitle')}</Text>
              <Text style={[styles.expandedBody, { color: colors.textSecondary }]}>
                {t('payments.expanded.oxyPayBody')}
              </Text>
            </>
          )}
          {expanded === 'faircoin-method' && (
            <>
              <Text style={[styles.expandedTitle, { color: colors.text }]}>{t('payments.methods.fairwallet')}</Text>
              <Text style={[styles.expandedBody, { color: colors.textSecondary }]}>
                {t('payments.expanded.fairwalletBody')}
              </Text>
            </>
          )}
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  expandedDetails: {
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
    borderWidth: 1,
  },
  expandedTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },
  expandedBody: {
    fontSize: 14,
    lineHeight: 20,
  },
});
