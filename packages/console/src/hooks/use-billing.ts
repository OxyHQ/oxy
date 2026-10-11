import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services';

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  creditsPerMonth: number;
  price: number;
  stripePriceId: string;
  currency: string;
}

export interface Subscription {
  _id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: 'active' | 'canceled' | 'past_due' | 'unpaid' | 'trialing';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: {
    name: string;
    creditsPerMonth: number;
    price: number;
    currency: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  _id: string;
  userId: string;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  type: 'credit_purchase' | 'subscription_payment' | 'refund';
  amount: number;
  currency: string;
  credits: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Credits {
  credits: number;
  freeCredits: number;
  paidCredits: number;
  dailyRefresh: number;
  lastRefresh: string | null;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
}

export interface CancelSubscriptionResult {
  message: string;
  subscription: Subscription;
}

// ======================
// Credits
// ======================

export function useCredits() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;

  return useQuery({
    queryKey: ['credits', subject],
    queryFn: () => oxyServices.request<Credits>('GET', '/credits/', undefined, { cache: false }),
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
    enabled: !!subject && isReady && isAuthenticated,
  });
}

// ======================
// Credit Packages
// ======================

export function useCreditPackages() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;

  return useQuery({
    queryKey: ['credit-packages', subject],
    queryFn: async (): Promise<Array<CreditPackage>> => {
      const result = await oxyServices.request<{ packages: Array<CreditPackage> }>(
        'GET',
        '/billing/packages',
      );
      return result.packages;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
    enabled: !!subject && isReady && isAuthenticated,
  });
}

// ======================
// Subscription Plans
// ======================

export function useSubscriptionPlans() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;

  return useQuery({
    queryKey: ['subscription-plans', subject],
    queryFn: async (): Promise<Array<SubscriptionPlan>> => {
      const result = await oxyServices.request<{ plans: Array<SubscriptionPlan> }>(
        'GET',
        '/billing/plans',
      );
      return result.plans;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
    enabled: !!subject && isReady && isAuthenticated,
  });
}

// ======================
// Current Subscription
// ======================

export function useSubscription() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;

  return useQuery({
    queryKey: ['subscription', subject],
    queryFn: async (): Promise<Subscription | null> => {
      const result = await oxyServices.request<{ subscription: Subscription | null }>(
        'GET',
        '/billing/subscription',
        undefined,
        { cache: false },
      );
      return result.subscription;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
    enabled: !!subject && isReady && isAuthenticated,
  });
}

// ======================
// Transactions
// ======================

export function useTransactions(limit = 20, offset = 0) {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;

  return useQuery({
    queryKey: ['transactions', subject, limit, offset],
    queryFn: () =>
      oxyServices.request<{ transactions: Array<Transaction>; total: number }>(
        'GET',
        '/billing/transactions',
        { limit, offset },
        { cache: false },
      ),
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
    enabled: !!subject && isReady && isAuthenticated,
  });
}

// ======================
// Checkout
// ======================

export function useCreateCheckout() {
  const { oxyServices } = useAuth();

  return useMutation({
    mutationFn: ({
      packageId,
      successUrl,
      cancelUrl,
    }: {
      packageId: string;
      successUrl: string;
      cancelUrl: string;
    }): Promise<CheckoutSession> =>
      oxyServices.request<CheckoutSession>('POST', '/billing/checkout/credits', {
        packageId,
        successUrl,
        cancelUrl,
      }),
  });
}

export function useCreateSubscriptionCheckout() {
  const { oxyServices } = useAuth();

  return useMutation({
    mutationFn: ({
      planId,
      successUrl,
      cancelUrl,
    }: {
      planId: string;
      successUrl: string;
      cancelUrl: string;
    }): Promise<CheckoutSession> =>
      oxyServices.request<CheckoutSession>('POST', '/billing/checkout/subscription', {
        planId,
        successUrl,
        cancelUrl,
      }),
  });
}

export function useCancelSubscription() {
  const { oxyServices } = useAuth();

  return useMutation({
    mutationFn: (): Promise<CancelSubscriptionResult> =>
      oxyServices.request<CancelSubscriptionResult>('POST', '/billing/subscription/cancel'),
  });
}

export function useCreatePortalSession() {
  const { oxyServices } = useAuth();

  return useMutation({
    mutationFn: async (returnUrl: string): Promise<string> => {
      const result = await oxyServices.request<{ url: string }>('POST', '/billing/portal', {
        returnUrl,
      });
      return result.url;
    },
  });
}

/** Access provenance remains separate from the API-credit balance and exact-money ledger. */
export function useProductSubscriptions() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;
  return useQuery({
    queryKey: ['product-subscriptions', subject],
    queryFn: () => oxyServices.billing.productSubscriptions(),
    enabled: !!subject && isReady && isAuthenticated,
    staleTime: 0,
  });
}
export function useCreditGrants() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;
  return useQuery({
    queryKey: ['credit-grants', subject],
    queryFn: () => oxyServices.billing.creditGrants(),
    enabled: !!subject && isReady && isAuthenticated,
    staleTime: 0,
  });
}
export function useCreditSubscriptions() {
  const { oxyServices, isAuthenticated, isReady, user } = useAuth();
  const subject = user?.id;
  return useQuery({
    queryKey: ['credit-subscriptions', subject],
    queryFn: async () =>
      (
        await oxyServices.request<{ subscriptions: Subscription[] }>(
          'GET',
          '/billing/subscriptions',
          undefined,
          { cache: false },
        )
      ).subscriptions,
    enabled: !!subject && isReady && isAuthenticated,
    staleTime: 0,
  });
}
export function useCancelNamedSubscription() {
  const { oxyServices, user } = useAuth();
  const queries = useQueryClient();
  const currentSubject = useRef(user?.id);
  currentSubject.current = user?.id;
  return useMutation({
    mutationFn: async ({
      id,
      kind,
      subject,
    }: {
      id: string;
      kind: 'product' | 'credit';
      subject: string;
    }) => {
      if (currentSubject.current !== subject)
        throw new Error('The signed-in account changed; reload this subscription');
      if (kind === 'product')
        return oxyServices.billing.cancelProductSubscriptionWithStatus(id, subject);
      await oxyServices.request('POST', '/billing/subscriptions/cancel', {
        subscriptionId: id,
        expectedSubjectAccountId: subject,
      });
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        queries.invalidateQueries({ queryKey: ['product-subscriptions', variables.subject] }),
        queries.invalidateQueries({ queryKey: ['credit-subscriptions', variables.subject] }),
        queries.invalidateQueries({ queryKey: ['subscription', variables.subject] }),
      ]);
    },
  });
}
