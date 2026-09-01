import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { toast } from '@oxyhq/bloom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useCreateCheckout,
  useCreateSubscriptionCheckout,
  useCreditPackages,
  useCredits,
  useSubscription,
  useSubscriptionPlans,
  useTransactions,
} from '@/hooks/use-billing';
import { getErrorMessage } from '@/lib/api-error';

export const Route = createFileRoute('/_layout/billing')({
  component: BillingPage,
});

function BillingPage() {
  const { data: credits, isLoading: isLoadingCredits } = useCredits();
  const { data: packages = [], isLoading: isLoadingPackages } = useCreditPackages();
  const { data: subscription } = useSubscription();
  const { data: plans = [] } = useSubscriptionPlans();
  const { data: transactionsData, isLoading: isLoadingTransactions } = useTransactions();
  const createCheckout = useCreateCheckout();
  const createSubscriptionCheckout = useCreateSubscriptionCheckout();

  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);

  const handlePurchase = async (packageId: string) => {
    try {
      const result = await createCheckout.mutateAsync({
        packageId,
        successUrl: `${window.location.origin}/billing?success=true`,
        cancelUrl: `${window.location.origin}/billing?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to create checkout session'));
    }
  };

  const handleUpgrade = async (planId: string) => {
    try {
      const result = await createSubscriptionCheckout.mutateAsync({
        planId,
        successUrl: `${window.location.origin}/billing?success=true`,
        cancelUrl: `${window.location.origin}/billing?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to create subscription checkout'));
    }
  };

  const transactions = transactionsData?.transactions ?? [];

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your credits and subscription
        </p>
      </div>

      {/* Credit Balance */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Credit balance</p>
        {isLoadingCredits ? (
          <div className="flex flex-row gap-12">
            {[1, 2, 3].map((i) => (
              <Skeleton.Box key={i} width={96} height={48} />
            ))}
          </div>
        ) : (
          <div className="flex flex-row gap-12">
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(credits?.credits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Total credits</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(credits?.freeCredits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Free credits</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {(credits?.paidCredits ?? 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">Paid credits</p>
            </div>
          </div>
        )}
      </div>

      {/* Current Plan */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Current plan</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-lg font-semibold text-foreground">
              {subscription?.plan?.name || 'Free Plan'}
            </p>
            <p className="text-sm text-muted-foreground">
              {subscription
                ? `${subscription.plan.creditsPerMonth.toLocaleString()} credits/month`
                : '300 free credits daily refresh'}
            </p>
          </div>
          {!subscription && (
            <Button variant="outline" size="sm" onClick={() => setShowUpgradeDialog(true)}>
              Upgrade plan
            </Button>
          )}
          {subscription && (
            <Badge variant={subscription.cancelAtPeriodEnd ? 'secondary' : 'default'}>
              {subscription.cancelAtPeriodEnd ? 'Cancels at period end' : 'Active'}
            </Badge>
          )}
        </div>
      </div>

      {/* Credit Packages */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Purchase credits</p>
        {isLoadingPackages ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton.Box key={i} width="100%" height={64} />
            ))}
          </div>
        ) : packages.length > 0 ? (
          <div>
            {packages.map((pkg, index) => (
              <div
                key={pkg.id}
                className={`flex items-center justify-between py-4 ${
                  index < packages.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {pkg.credits.toLocaleString()} credits
                  </p>
                  <p className="text-sm text-muted-foreground">
                    ${(pkg.price / 100).toFixed(2)} {pkg.currency.toUpperCase()}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePurchase(pkg.id)}
                  disabled={createCheckout.isPending}
                >
                  {createCheckout.isPending ? 'Loading...' : 'Purchase'}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4">
            No credit packages available at the moment.
          </p>
        )}
      </div>

      {/* Transaction History */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-foreground mb-4">Transaction history</p>
        {isLoadingTransactions ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton.Box key={i} width="100%" height={48} />
            ))}
          </div>
        ) : transactions.length > 0 ? (
          <div>
            {transactions.map((tx, index) => (
              <div
                key={tx._id}
                className={`flex items-center justify-between py-3 ${
                  index < transactions.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {tx.description || tx.type.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-foreground">
                    +{tx.credits.toLocaleString()} credits
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ${(tx.amount / 100).toFixed(2)} {tx.currency.toUpperCase()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4">No transactions yet.</p>
        )}
      </div>

      {/* Upgrade Plan Dialog */}
      <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upgrade your plan</DialogTitle>
            <DialogDescription>
              Choose a subscription plan to get more credits each month.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="flex items-center justify-between p-4 border border-border rounded-lg"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">{plan.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {plan.creditsPerMonth.toLocaleString()} credits/month
                  </p>
                  <p className="text-sm text-muted-foreground">
                    ${(plan.price / 100).toFixed(2)}/month
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => handleUpgrade(plan.id)}
                  disabled={createSubscriptionCheckout.isPending}
                >
                  {createSubscriptionCheckout.isPending ? 'Loading...' : 'Subscribe'}
                </Button>
              </div>
            ))}
            {plans.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No subscription plans available at the moment.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUpgradeDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}
