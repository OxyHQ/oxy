import {
  Admonition,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { useState } from 'react';
import { statusBadge } from '@/components/billing/labels';
import {
  useCancelNamedSubscription,
  useCreateCheckout,
  useCreateSubscriptionCheckout,
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

type PendingCancel = { kind: 'product' | 'credit'; id: string; name: string };

/**
 * Product plans and credits — the SIGNED-IN USER's subscription, not the
 * account's pay-as-you-go inference balance.
 *
 * Product offers grant named product rights, API-credit plans buy monthly API
 * credits, and inference spend is exact money settled per request through the
 * financial ledger. They share no unit, are never added together, and live on
 * different pages for that reason (#972). The other billing pages read
 * `/billing/accounts/*` and `/inference/reporting/*`; this one reads the
 * pre-existing `/billing` routes, which key on the signed-in user.
 */
export default function BillingPlansPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: credits, isLoading: isLoadingCredits } = useCredits();
  const { data: packages = [], isLoading: isLoadingPackages } = useCreditPackages();
  const creditSubscriptions = useCreditSubscriptions();
  const productSubscriptions = useProductSubscriptions();
  const creditGrants = useCreditGrants();
  const cancelNamed = useCancelNamedSubscription();
  const liveCreditPlans = (creditSubscriptions.data ?? []).filter((plan) =>
    ['active', 'trialing'].includes(plan.status),
  );
  const { data: plans = [] } = useSubscriptionPlans();
  const { data: transactionsData, isLoading: isLoadingTransactions } = useTransactions();
  const createCheckout = useCreateCheckout();
  const createSubscriptionCheckout = useCreateSubscriptionCheckout();

  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<PendingCancel | null>(null);

  const handlePurchase = async (packageId: string) => {
    try {
      const result = await createCheckout.mutateAsync({
        packageId,
        successUrl: `${window.location.origin}/billing/plans?success=true`,
        cancelUrl: `${window.location.origin}/billing/plans?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.plans.checkoutFailed')));
    }
  };

  const handleUpgrade = async (planId: string) => {
    try {
      const result = await createSubscriptionCheckout.mutateAsync({
        planId,
        successUrl: `${window.location.origin}/billing/plans?success=true`,
        cancelUrl: `${window.location.origin}/billing/plans?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.plans.subscriptionCheckoutFailed')));
    }
  };

  const handleCancel = async () => {
    if (pendingCancel === null) {
      return;
    }
    try {
      const result = await cancelNamed.mutateAsync({
        kind: pendingCancel.kind,
        id: pendingCancel.id,
        subject: user?.id ?? '',
      });
      if (pendingCancel.kind === 'product' && result && 'reconciliationPending' in result) {
        toast.info(t('billingPage.plans.cancelPending'));
      }
      setPendingCancel(null);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.plans.cancelFailed')));
    }
  };

  const transactions = transactionsData?.transactions ?? [];
  const sources = productSubscriptions.data ?? [];
  const grants = creditGrants.data ?? [];

  const cancelCopy =
    pendingCancel === null
      ? undefined
      : t(
          pendingCancel.kind === 'product'
            ? 'billingPage.plans.cancelProductConfirm'
            : 'billingPage.plans.cancelCreditConfirm',
          { name: pendingCancel.name },
        );

  return (
    <ScreenScrollView contentContainerClassName="gap-6 px-4 py-6 pb-12">
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

      {isLoadingCredits ? (
        <Skeleton.Box width="100%" height={132} />
      ) : (
        <GroupedSection title={t('billingPage.plans.creditBalance')}>
          <GroupedSectionItem
            title={t('billingPage.plans.totalCredits')}
            value={(credits?.credits ?? 0).toLocaleString()}
          />
          <GroupedSectionItem
            title={t('billingPage.plans.freeCredits')}
            value={(credits?.freeCredits ?? 0).toLocaleString()}
          />
          <GroupedSectionItem
            title={t('billingPage.plans.paidCredits')}
            value={(credits?.paidCredits ?? 0).toLocaleString()}
          />
        </GroupedSection>
      )}

      {productSubscriptions.isError ? (
        <Admonition type="error">{t('billingPage.plans.productSubscriptionsError')}</Admonition>
      ) : productSubscriptions.isLoading ? (
        <Muted>{t('billingPage.plans.loadingSubscriptions')}</Muted>
      ) : sources.length === 0 ? (
        <GroupedSection title={t('billingPage.plans.productSubscriptions')}>
          <GroupedSectionItem title={t('billingPage.plans.noProductSubscriptions')} />
        </GroupedSection>
      ) : (
        <GroupedSection title={t('billingPage.plans.productSubscriptions')}>
          {sources.map((source) => (
            <GroupedSectionItem
              key={source.sourceId}
              title={source.offers.map((offer) => offer.displayName).join(', ')}
              titleNumberOfLines={0}
              description={[
                t('billingPage.plans.products', {
                  products: source.offers
                    .flatMap((offer) => offer.products.map((product) => product.displayName))
                    .join(', '),
                }),
                ...source.offers.map(
                  (offer) =>
                    `${offer.displayName} · ${t(
                      offer.origin === 'bundle'
                        ? 'billingPage.plans.bundle'
                        : 'billingPage.plans.individual',
                    )} · ${t(
                      offer.current
                        ? 'billingPage.plans.currentPeriod'
                        : 'billingPage.plans.paidHistory',
                    )} · ${new Date(offer.period.start).toLocaleDateString()} – ${new Date(offer.period.end).toLocaleDateString()}`,
                ),
                `${source.status} · ${new Date(source.period.start).toLocaleDateString()} – ${new Date(source.period.end).toLocaleDateString()}`,
              ].join('\n')}
              rightElement={
                source.cancelAtPeriodEnd ? (
                  <Badge content={t('billingPage.plans.cancelsAtPeriodEnd')} {...statusBadge()} />
                ) : source.canCancel ? (
                  <Button
                    appearance="outline"
                    size="sm"
                    disabled={cancelNamed.isPending}
                    onPress={() =>
                      setPendingCancel({
                        kind: 'product',
                        id: source.sourceId,
                        name: source.offers.map((offer) => offer.displayName).join(', '),
                      })
                    }
                  >
                    {t('billingPage.plans.cancelSubscription')}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </GroupedSection>
      )}

      {creditSubscriptions.isError ? (
        <Admonition type="error">{t('billingPage.plans.creditPlansError')}</Admonition>
      ) : (
        <GroupedSection
          title={t('billingPage.plans.creditPlans')}
          footer={liveCreditPlans.length === 0 ? t('billingPage.plans.freeRefresh') : undefined}
        >
          {liveCreditPlans.map((plan) => (
            <GroupedSectionItem
              key={plan._id}
              title={t('billingPage.plans.creditsPerMonth', {
                name: plan.plan.name,
                credits: plan.plan.creditsPerMonth.toLocaleString(),
              })}
              titleNumberOfLines={0}
              description={t('billingPage.plans.through', {
                status: plan.status,
                date: new Date(plan.currentPeriodEnd).toLocaleDateString(),
              })}
              rightElement={
                plan.cancelAtPeriodEnd ? (
                  <Badge content={t('billingPage.plans.cancelsAtPeriodEnd')} {...statusBadge()} />
                ) : (
                  <Button
                    appearance="outline"
                    size="sm"
                    disabled={cancelNamed.isPending}
                    onPress={() =>
                      setPendingCancel({ kind: 'credit', id: plan._id, name: plan.plan.name })
                    }
                  >
                    {t('billingPage.plans.cancelCreditPlan')}
                  </Button>
                )
              }
            />
          ))}
          {liveCreditPlans.length === 0 && (
            <GroupedSectionItem
              title={t('billingPage.plans.chooseCreditPlan')}
              onPress={() => setShowUpgradeDialog(true)}
            />
          )}
        </GroupedSection>
      )}

      {creditGrants.isError ? (
        <Admonition type="error">{t('billingPage.plans.grantsError')}</Admonition>
      ) : (
        grants.length > 0 && (
          <GroupedSection
            title={t('billingPage.plans.grantsTitle')}
            footer={t('billingPage.plans.grantsBody')}
          >
            {grants.map((grant) => (
              <GroupedSectionItem
                key={grant.id}
                title={`${grant.origin.replaceAll('_', ' ')}${grant.promotionId ? ` · ${grant.promotionId}` : ''}`}
                titleNumberOfLines={0}
                description={[
                  t('billingPage.plans.grantAmounts', {
                    granted: grant.granted.toLocaleString(),
                    consumed: grant.consumed.toLocaleString(),
                    refunded: grant.clawed.toLocaleString(),
                    remaining: grant.remaining.toLocaleString(),
                  }),
                  t('billingPage.plans.grantInvoice', {
                    invoice: grant.invoiceId,
                    start: new Date(grant.period.start).toLocaleDateString(),
                    end: new Date(grant.period.end).toLocaleDateString(),
                  }),
                ].join('\n')}
              />
            ))}
          </GroupedSection>
        )
      )}

      {isLoadingPackages ? (
        <Skeleton.Box width="100%" height={132} />
      ) : packages.length > 0 ? (
        <GroupedSection title={t('billingPage.plans.purchaseTitle')}>
          {packages.map((pkg) => (
            <GroupedSectionItem
              key={pkg.id}
              title={t('billingPage.plans.creditsCount', { credits: pkg.credits.toLocaleString() })}
              description={`$${(pkg.price / 100).toFixed(2)} ${pkg.currency.toUpperCase()}`}
              rightElement={
                <Button
                  appearance="outline"
                  size="sm"
                  onPress={() => handlePurchase(pkg.id)}
                  disabled={createCheckout.isPending}
                >
                  {createCheckout.isPending ? t('common.loading') : t('billingPage.plans.purchase')}
                </Button>
              }
            />
          ))}
        </GroupedSection>
      ) : (
        <Muted>{t('billingPage.plans.noPackages')}</Muted>
      )}

      {isLoadingTransactions ? (
        <Skeleton.Box width="100%" height={132} />
      ) : transactions.length > 0 ? (
        <GroupedSection title={t('billingPage.plans.transactions')}>
          {transactions.map((tx) => (
            <GroupedSectionItem
              key={tx._id}
              title={tx.description || tx.type.replace(/_/g, ' ')}
              description={new Date(tx.createdAt).toLocaleDateString()}
              value={`${t('billingPage.plans.plusCredits', { credits: tx.credits.toLocaleString() })} · $${(tx.amount / 100).toFixed(2)} ${tx.currency.toUpperCase()}`}
            />
          ))}
        </GroupedSection>
      ) : (
        <Muted>{t('billingPage.plans.noTransactions')}</Muted>
      )}

      <Dialog
        open={pendingCancel !== null}
        onClose={() => setPendingCancel(null)}
        title={t('billingPage.plans.cancelTitle')}
        description={cancelCopy}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: t('billingPage.plans.cancelConfirmAction'),
            color: 'destructive',
            onPress: handleCancel,
            loading: cancelNamed.isPending,
            disabled: cancelNamed.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      />

      <Dialog
        open={showUpgradeDialog}
        onClose={() => setShowUpgradeDialog(false)}
        title={t('billingPage.plans.upgradeTitle')}
        description={t('billingPage.plans.upgradeBody')}
        scrollable
        actions={[{ label: t('common.cancel'), color: 'cancel' }]}
      >
        {plans.length === 0 ? (
          <Muted>{t('billingPage.plans.noPlans')}</Muted>
        ) : (
          <GroupedSection>
            {plans.map((plan) => (
              <GroupedSectionItem
                key={plan.id}
                title={plan.name}
                description={`${t('billingPage.plans.planCredits', {
                  credits: plan.creditsPerMonth.toLocaleString(),
                })}\n${t('billingPage.plans.planPrice', { price: (plan.price / 100).toFixed(2) })}`}
                rightElement={
                  <Button
                    size="sm"
                    onPress={() => handleUpgrade(plan.id)}
                    disabled={createSubscriptionCheckout.isPending}
                  >
                    {createSubscriptionCheckout.isPending
                      ? t('common.loading')
                      : t('billingPage.plans.subscribe')}
                  </Button>
                }
              />
            ))}
          </GroupedSection>
        )}
      </Dialog>
    </ScreenScrollView>
  );
}
