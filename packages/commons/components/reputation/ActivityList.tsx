import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { CenteredState } from '@/components/ui/centered-state';
import { ActivityRow } from '@/components/reputation/ActivityRow';
import type { ReputationTransaction } from '@oxyhq/contracts';
import { useTranslation } from '@/lib/i18n';

interface ActivityListProps {
  transactions: ReputationTransaction[] | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * The recent reputation activity feed — the "Activity" tab body. Renders the
 * most recent ledger entries as clean, borderless rows (separated by a hairline
 * inset that clears the leading icon badge), with shared loading, error, and
 * empty states. It never owns its own scroller: it sits inside the screen's
 * single vertical scroll.
 */
export function ActivityList({ transactions, isLoading, isError }: ActivityListProps) {
  const colors = useColors();
  const { t } = useTranslation();

  if (isLoading && !transactions) {
    return <CenteredState loading body={t('civic.reputation.activity.loading')} />;
  }

  if (isError && !transactions) {
    return (
      <CenteredState icon="cloud-alert" body={t('civic.reputation.activity.error')} />
    );
  }

  if (!transactions || transactions.length === 0) {
    return <CenteredState icon="history" body={t('civic.reputation.activity.empty')} />;
  }

  return (
    <View>
      {transactions.map((transaction, index) => (
        <View
          key={transaction.id}
          style={index > 0 ? [styles.divider, { borderTopColor: colors.border }] : undefined}
        >
          <ActivityRow transaction={transaction} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginLeft: 50,
  },
});
