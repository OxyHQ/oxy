import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Dialog } from '@oxy.so/bloom/dialog';
import { BillingScreen } from '@/components/billing/BillingScreen';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { useCallback, useState } from 'react';

import { CreditGrantsTable } from '@/components/billing/CreditGrantsTable';
import { CreditStats } from '@/components/billing/CreditStats';
import { PlanPicker } from '@/components/billing/PlanPicker';
import { PurchaseCredits } from '@/components/billing/PurchaseCredits';
import { type PendingCancel, SubscriptionsTable } from '@/components/billing/SubscriptionsTable';
import { TransactionsTable } from '@/components/billing/TransactionsTable';
import { ApiState } from '@/components/loading/ApiState';
import { StatsSkeleton, TableSkeleton } from '@/components/loading/ContentSkeleton';
import {
  useCancelNamedSubscription,
  useCreditGrants,
  useCreditPackages,
  useCreditSubscriptions,
  useCredits,
  useProductSubscriptions,
  useSubscriptionPlans,
  useTransactions,
} from '@/hooks/use-billing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

/**
 * Product plans and credits: the SIGNED-IN USER's subscriptions, not the account's
 * pay-as-you-go inference balance.
 *
 * Product offers grant named rights, API-credit plans buy monthly credits, and
 * inference spend is exact money settled per request through the ledger. They share
 * no unit and are never added together (#972), which is what the explainer says.
 * This tab reads the `/billing` routes, which key on the signed-in user.
 */
export default function BillingPlansPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const credits = useCredits();
  const packages = useCreditPackages();
  const plans = useSubscriptionPlans();
  const creditSubscriptions = useCreditSubscriptions();
  const productSubscriptions = useProductSubscriptions();
  const grants = useCreditGrants();
  const transactions = useTransactions();
  const cancel = useCancelNamedSubscription();
  const [pending, setPending] = useState<PendingCancel | null>(null);

  const liveCreditPlans = (creditSubscriptions.data ?? []).filter((plan) =>
    ['active', 'trialing'].includes(plan.status),
  );

  const confirmCancel = async () => {
    if (pending === null) return;
    try {
      const result = await cancel.mutateAsync({
        kind: pending.kind,
        id: pending.id,
        subject: user?.id ?? '',
      });
      if (pending.kind === 'product' && result && 'reconciliationPending' in result) {
        toast.info(t('billingPage.plans.cancelPending'));
      }
      setPending(null);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.plans.cancelFailed')));
    }
  };

  const askCancel = useCallback((next: PendingCancel) => setPending(next), []);

  const subscriptionsError = productSubscriptions.error ?? creditSubscriptions.error;

  return (
    <BillingScreen contentContainerClassName="gap-4 p-4 pb-12">
      <AdmonitionRoot type="info">
        <AdmonitionRow>
          <AdmonitionIcon />
          <AdmonitionContent>
            <AdmonitionText style={{ fontWeight: '600' }}>
              {t('billingPage.plans.explainerTitle')}
            </AdmonitionText>
            <AdmonitionText>{t('billingPage.plans.explainerBody')}</AdmonitionText>
          </AdmonitionContent>
        </AdmonitionRow>
      </AdmonitionRoot>

      {credits.isLoading ? (
        <StatsSkeleton count={3} />
      ) : credits.isError ? (
        <ApiState error={credits.error} onRetry={() => void credits.refetch()} />
      ) : credits.data === undefined ? null : (
        <CreditStats
          credits={credits.data}
          planName={liveCreditPlans[0]?.plan.name ?? t('billingPage.plans.freePlan')}
        />
      )}

      {productSubscriptions.isLoading || creditSubscriptions.isLoading ? (
        <TableSkeleton rows={3} columns={4} />
      ) : subscriptionsError !== null ? (
        <ApiState
          error={subscriptionsError}
          onRetry={() => {
            void productSubscriptions.refetch();
            void creditSubscriptions.refetch();
          }}
        />
      ) : (
        <SubscriptionsTable
          products={productSubscriptions.data ?? []}
          creditPlans={creditSubscriptions.data ?? []}
          onCancel={askCancel}
        />
      )}

      {liveCreditPlans.length === 0 && !plans.isLoading ? (
        <PlanPicker plans={plans.data ?? []} />
      ) : null}

      {packages.isLoading ? (
        <TableSkeleton rows={2} columns={2} />
      ) : (packages.data ?? []).length > 0 ? (
        <PurchaseCredits packages={packages.data ?? []} />
      ) : null}

      {grants.isError ? (
        <ApiState error={grants.error} onRetry={() => void grants.refetch()} />
      ) : grants.isLoading ? (
        <TableSkeleton rows={3} columns={5} />
      ) : (
        <>
          <CreditGrantsTable grants={grants.data ?? []} />
          <Muted className="px-1 text-xs text-muted-foreground">
            {t('billingPage.plans.grantsNote')}
          </Muted>
        </>
      )}

      {transactions.isError ? (
        <ApiState error={transactions.error} onRetry={() => void transactions.refetch()} />
      ) : transactions.isLoading ? (
        <TableSkeleton rows={4} columns={5} />
      ) : (
        <TransactionsTable transactions={transactions.data?.transactions ?? []} />
      )}

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t('billingPage.plans.cancelTitle')}
        description={
          pending === null
            ? undefined
            : t(
                pending.kind === 'product'
                  ? 'billingPage.plans.cancelProductConfirm'
                  : 'billingPage.plans.cancelCreditConfirm',
                { name: pending.name },
              )
        }
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: t('billingPage.plans.cancelConfirmAction'),
            color: 'destructive',
            onPress: confirmCancel,
            loading: cancel.isPending,
            disabled: cancel.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />
    </BillingScreen>
  );
}
