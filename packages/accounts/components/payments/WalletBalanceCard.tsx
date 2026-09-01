import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { darkenColor } from '@/utils/color-utils';
import { formatFairCoinBalance } from '@/utils/payment-utils';

interface WalletBalanceCardProps {
  /** Current FairCoin balance, in FairCoin units. */
  balance: number;
  /** Number of wallet ledger transactions, shown in the summary cards. */
  transactionCount: number;
  /** Number of billing/payment history entries, shown in the summary cards. */
  paymentCount: number;
}

/**
 * Hero card showing the user's FairCoin wallet balance plus quick counts of
 * their wallet transactions and billing history entries.
 */
export function WalletBalanceCard({
  balance,
  transactionCount,
  paymentCount,
}: WalletBalanceCardProps) {
  const colors = useColors();
  const { t } = useTranslation();

  return (
    <View style={[styles.walletCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.walletIconWrapper}>
        <View style={[styles.walletIconContainer, { backgroundColor: colors.sidebarIconPayments }]}>
          <MaterialCommunityIcons name="wallet-outline" size={48} color={darkenColor(colors.sidebarIconPayments)} />
        </View>
      </View>

      <View style={styles.walletBalanceWrapper}>
        <Text style={[styles.walletBalance, { color: colors.text }]}>
          {formatFairCoinBalance(balance)}
        </Text>
        <Text style={[styles.walletSubtitle, { color: colors.textSecondary }]}>
          {t('payments.wallet.subtitle')}
        </Text>
      </View>

      <View style={styles.walletSummaryCards}>
        <View style={[styles.summaryCard, { backgroundColor: colors.background }]}>
          <Text style={[styles.summaryCardValue, { color: colors.text }]}>
            {transactionCount}
          </Text>
          <Text style={[styles.summaryCardLabel, { color: colors.textSecondary }]}>
            {t('payments.wallet.transactions')}
          </Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: colors.background }]}>
          <Text style={[styles.summaryCardValue, { color: colors.text }]}>
            {paymentCount}
          </Text>
          <Text style={[styles.summaryCardLabel, { color: colors.textSecondary }]}>
            {t('payments.wallet.payments')}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  walletCard: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 24,
    marginBottom: 24,
  },
  walletIconWrapper: {
    alignItems: 'center',
    marginBottom: 16,
  },
  walletIconContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletBalanceWrapper: {
    alignItems: 'center',
    marginBottom: 24,
  },
  walletBalance: {
    fontSize: 40,
    fontWeight: Platform.OS === 'web' ? 'bold' : undefined,
    marginBottom: 8,
  },
  walletSubtitle: {
    fontSize: 14,
    opacity: 0.7,
  },
  walletSummaryCards: {
    flexDirection: 'row',
    gap: 12,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
  },
  summaryCardValue: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  summaryCardLabel: {
    fontSize: 13,
    opacity: 0.8,
  },
});
