import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Payment } from '@oxy.so/services';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, EmptyStateCard } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { formatDate } from '@/utils/date-utils';

interface BillingHistorySectionProps {
  /** Billing / payment history entries, newest first. */
  payments: Payment[];
}

/** Default currency label for FairCoin-denominated billing entries. */
const DEFAULT_CURRENCY = 'FAIR';

/**
 * "Billing history" section: lists the user's payment / deposit history with a
 * colored status badge per row, or a localized empty state when there are
 * none.
 */
export function BillingHistorySection({ payments }: BillingHistorySectionProps) {
  const colors = useColors();
  const { t } = useTranslation();

  const getPaymentStatusColor = useCallback((status: string): string => {
    switch (status.toLowerCase()) {
      case 'completed':
      case 'succeeded':
      case 'paid':
        return colors.success;
      case 'pending':
      case 'processing':
        return colors.warning;
      case 'failed':
      case 'declined':
        return colors.error;
      default:
        return colors.textSecondary;
    }
  }, [colors]);

  const getPaymentStatusLabel = useCallback((status: string): string => {
    const lower = status.toLowerCase();
    const key = `payments.status.${lower}`;
    const translated = t(key);
    if (translated !== key) return translated;
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  }, [t]);

  const items = useMemo(() => {
    return payments.map((payment, index) => {
      const date = payment.timestamp ? formatDate(payment.timestamp) : t('payments.history.unknownDate');
      const amount = payment.amount.toFixed(2);
      const status = payment.status || 'completed';

      return {
        id: `billing-${payment.id || index}`,
        icon: 'file-document-outline',
        iconColor: colors.sidebarIconData,
        title: `${amount} ${DEFAULT_CURRENCY}`,
        subtitle: date,
        customContent: (
          <View style={styles.statusBadge}>
            <View style={[styles.statusDot, { backgroundColor: getPaymentStatusColor(status) }]} />
            <Text style={[styles.statusText, { color: getPaymentStatusColor(status) }]}>
              {getPaymentStatusLabel(status)}
            </Text>
          </View>
        ),
      };
    });
  }, [payments, colors, getPaymentStatusColor, getPaymentStatusLabel, t]);

  return (
    <Section title={t('payments.sections.billingHistory')}>
      {items.length > 0 ? (
        <AccountCard>
          <GroupedSection items={items} />
        </AccountCard>
      ) : (
        <EmptyStateCard
          icon="file-document-outline"
          title={t('payments.history.noBilling')}
          subtitle={t('payments.history.noBillingSubtitle')}
          subtitleColor={colors.textSecondary}
        />
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
