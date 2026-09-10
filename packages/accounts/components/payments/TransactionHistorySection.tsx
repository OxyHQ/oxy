import React, { useCallback, useMemo } from 'react';
import { Text, StyleSheet } from 'react-native';
import type { WalletTransaction } from '@oxy.so/services';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard, EmptyStateCard } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { formatDate } from '@/utils/date-utils';
import { isCreditTransaction } from '@/utils/payment-utils';

interface TransactionHistorySectionProps {
  /** Wallet ledger entries, newest first. */
  transactions: WalletTransaction[];
}

/**
 * "Transaction history" section: lists the user's wallet ledger entries with a
 * signed amount (credits in green, debits in the default text color), or a
 * localized empty state when there are none.
 */
export function TransactionHistorySection({ transactions }: TransactionHistorySectionProps) {
  const colors = useColors();
  const { t } = useTranslation();

  const getTransactionTypeLabel = useCallback((type: string): string => {
    const lower = type.toLowerCase();
    const key = `payments.tx.${lower}`;
    const translated = t(key);
    if (translated !== key) return translated;
    return type.charAt(0).toUpperCase() + type.slice(1);
  }, [t]);

  const items = useMemo(() => {
    return transactions.map((tx, index) => {
      const date = tx.timestamp ? formatDate(tx.timestamp) : t('payments.history.unknownDate');
      const amount = tx.amount.toFixed(2);
      const isCredit = isCreditTransaction(tx.type);
      const txIcon = isCredit ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline';

      return {
        id: `tx-${tx.id || index}`,
        icon: txIcon,
        iconColor: isCredit ? colors.success : colors.sidebarIconPayments,
        title: getTransactionTypeLabel(tx.type),
        subtitle: date,
        customContent: (
          <Text style={[
            styles.transactionAmount,
            { color: isCredit ? colors.success : colors.text },
          ]}>
            {isCredit ? '+' : '-'} {amount}
          </Text>
        ),
      };
    });
  }, [transactions, colors, getTransactionTypeLabel, t]);

  return (
    <Section title={t('payments.sections.transactionHistory')}>
      {items.length > 0 ? (
        <AccountCard>
          <GroupedSection items={items} />
        </AccountCard>
      ) : (
        <EmptyStateCard
          icon="swap-horizontal"
          title={t('payments.history.noTransactions')}
          subtitle={t('payments.history.noTransactionsSubtitle')}
          subtitleColor={colors.textSecondary}
        />
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  transactionAmount: {
    fontSize: 15,
    fontWeight: '600',
  },
});
