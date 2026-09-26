import React from 'react';
import { Icons } from '@/constants/icons';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { View, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ActivityRow } from '@/components/reputation/ActivityRow';
import type { ReputationTransaction } from '@oxy.so/contracts';
import { useTranslation } from '@/lib/i18n';
import { LoadingState, STATE_MIN_HEIGHT } from '@/components/ui/loading-state';

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
    return <LoadingState description={t('civic.reputation.activity.loading')} />;
  }

  if (isError && !transactions) {
    return (
      <EmptyState
        icon={Icons.alert}
        description={t('civic.reputation.activity.error')}
        minHeight={STATE_MIN_HEIGHT}
      />
    );
  }

  if (!transactions || transactions.length === 0) {
    return <EmptyState
             icon={Icons.history}
             description={t('civic.reputation.activity.empty')}
             minHeight={STATE_MIN_HEIGHT}
           />;
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
