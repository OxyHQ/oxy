import { useMutation, useQuery } from '@tanstack/react-query';
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
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['credits'],
    queryFn: () => oxyServices.makeRequest<Credits>('GET', '/credits/'),
    staleTime: 1000 * 60, // 1 minute
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Credit Packages
// ======================

export function useCreditPackages() {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['credit-packages'],
    queryFn: async (): Promise<Array<CreditPackage>> => {
      const result = await oxyServices.makeRequest<{ packages: Array<CreditPackage> }>(
        'GET',
        '/billing/packages'
      );
      return result.packages;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Subscription Plans
// ======================

export function useSubscriptionPlans() {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['subscription-plans'],
    queryFn: async (): Promise<Array<SubscriptionPlan>> => {
      const result = await oxyServices.makeRequest<{ plans: Array<SubscriptionPlan> }>(
        'GET',
        '/billing/plans'
      );
      return result.plans;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Current Subscription
// ======================

export function useSubscription() {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['subscription'],
    queryFn: async (): Promise<Subscription | null> => {
      const result = await oxyServices.makeRequest<{ subscription: Subscription | null }>(
        'GET',
        '/billing/subscription'
      );
      return result.subscription;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    retry: 2,
    enabled: isReady && isAuthenticated,
  });
}

// ======================
// Transactions
// ======================

export function useTransactions(limit: number = 20, offset: number = 0) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: ['transactions', limit, offset],
    queryFn: () =>
      oxyServices.makeRequest<{ transactions: Array<Transaction>; total: number }>(
        'GET',
        '/billing/transactions',
        { limit, offset }
      ),
    staleTime: 1000 * 60, // 1 minute
    retry: 1,
    enabled: isReady && isAuthenticated,
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
      oxyServices.makeRequest<CheckoutSession>('POST', '/billing/checkout/credits', {
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
      oxyServices.makeRequest<CheckoutSession>('POST', '/billing/checkout/subscription', {
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
      oxyServices.makeRequest<CancelSubscriptionResult>('POST', '/billing/subscription/cancel'),
  });
}

export function useCreatePortalSession() {
  const { oxyServices } = useAuth();

  return useMutation({
    mutationFn: async (returnUrl: string): Promise<string> => {
      const result = await oxyServices.makeRequest<{ url: string }>('POST', '/billing/portal', {
        returnUrl,
      });
      return result.url;
    },
  });
}
