import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, ActivityIndicator } from 'react-native';
import {
  useOxy,
  useUserSubscription,
  useUserPayments,
  useUserWallet,
  useUserWalletTransactions,
} from '@oxy.so/services';
import type { Subscription, Payment, Wallet, WalletTransaction } from '@oxy.so/services';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useTranslation } from '@/lib/i18n';
import { PersonalPlansCard } from '@/components/payments/PersonalPlansCard';
import { PaymentsHeader } from '@/components/payments/PaymentsHeader';
import { FairCoinBanner } from '@/components/payments/FairCoinBanner';
import { WalletBalanceCard } from '@/components/payments/WalletBalanceCard';
import { SubscriptionCard } from '@/components/payments/SubscriptionCard';
import { WalletSection } from '@/components/payments/WalletSection';
import { PaymentMethodsSection } from '@/components/payments/PaymentMethodsSection';
import { BillingHistorySection } from '@/components/payments/BillingHistorySection';
import { TransactionHistorySection } from '@/components/payments/TransactionHistorySection';
import { PaymentsInfoSection } from '@/components/payments/PaymentsInfoSection';

/** Number of recent wallet transactions to fetch for the history preview. */
const WALLET_TRANSACTIONS_LIMIT = 5;

/**
 * Fallback subscription used when the subscription request fails. Mirrors the
 * API's "no subscription" shape so the UI degrades to the basic-plan state
 * instead of showing nothing.
 */
const FALLBACK_SUBSCRIPTION: Subscription = { plan: 'basic', status: 'active' };

/**
 * Payments screen. A thin composition over the payment subcomponents; all data
 * is loaded through the typed React Query hooks in `@oxy.so/services`
 * (`useUserSubscription` / `useUserPayments` / `useUserWallet` /
 * `useUserWalletTransactions`), so there is no imperative fetch effect here.
 *
 * Auth is enforced by the `(tabs)` layout, so a session is assumed.
 */
export default function PaymentsScreen() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const { t } = useTranslation();
  const { isLoading: oxyLoading } = useOxy();

  const subscriptionQuery = useUserSubscription();
  const paymentsQuery = useUserPayments();
  const walletQuery = useUserWallet();
  const transactionsQuery = useUserWalletTransactions({ limit: WALLET_TRANSACTIONS_LIMIT });

  // Derive the view models from the query results. On error we fall back to the
  // same defaults the previous imperative implementation used so the screen
  // degrades gracefully instead of disappearing.
  const subscription = useMemo<Subscription | null>(() => {
    if (subscriptionQuery.value) return subscriptionQuery.value;
    if (subscriptionQuery.status === 'error') return FALLBACK_SUBSCRIPTION;
    return null;
  }, [subscriptionQuery.value, subscriptionQuery.status]);

  // The answers are held in the account's store and stay the same object until
  // they change, so these need no memoization.
  const payments: Payment[] = paymentsQuery.value ?? [];
  const wallet: Wallet | null = walletQuery.value ?? null;
  const transactions: WalletTransaction[] = transactionsQuery.value?.data ?? [];

  // Initial full-screen loader: only while a query has no data yet and is still
  // loading. Once any data has resolved we render the screen and let
  // pull-to-refresh surface subsequent updates.
  const isInitialLoading =
    subscriptionQuery.isLoading ||
    paymentsQuery.isLoading ||
    walletQuery.isLoading ||
    transactionsQuery.isLoading;

  // Read again with something already on screen.
  const refreshing =
    (subscriptionQuery.isFetching && !subscriptionQuery.isLoading) ||
    (paymentsQuery.isFetching && !paymentsQuery.isLoading) ||
    (walletQuery.isFetching && !walletQuery.isLoading) ||
    (transactionsQuery.isFetching && !transactionsQuery.isLoading);

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      subscriptionQuery.refresh(),
      paymentsQuery.refresh(),
      walletQuery.refresh(),
      transactionsQuery.refresh(),
    ]);
  }, [subscriptionQuery, paymentsQuery, walletQuery, transactionsQuery]);

  if (isInitialLoading || oxyLoading) {
    return (
      <View
        style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}
      >
        <ActivityIndicator size="large" color={colors.tint} />
        <ThemedText style={[styles.loadingText, { color: colors.text }]}>
          {t('payments.loading')}
        </ThemedText>
      </View>
    );
  }

  const content = (
    <>
      <PersonalPlansCard />

      <FairCoinBanner />

      {wallet && (
        <WalletBalanceCard
          balance={wallet.balance || 0}
          transactionCount={transactions.length}
          paymentCount={payments.length}
        />
      )}

      <SubscriptionCard subscription={subscription} />

      <WalletSection balance={wallet?.balance || 0} />

      <PaymentMethodsSection subscription={subscription} balance={wallet?.balance || 0} />

      <BillingHistorySection payments={payments} />

      <TransactionHistorySection transactions={transactions} />

      <PaymentsInfoSection />
    </>
  );

  if (isDesktop) {
    return (
      <>
        <PaymentsHeader />
        {content}
      </>
    );
  }

  return (
    <ScreenContentWrapper refreshing={refreshing} onRefresh={handleRefresh}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <PaymentsHeader />
          {content}
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mobileContent: {
    padding: 16,
    paddingBottom: 120,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
});
