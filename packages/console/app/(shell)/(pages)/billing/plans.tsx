import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ConfirmDialog } from '@/components/account-pages/ConfirmDialog';
import { PageBody } from '@/components/account-pages/PageFrame';
import {
  Figure,
  FigureRow,
  Muted,
  Panel,
  Row,
  RowList,
  Section,
} from '@/components/account-pages/Section';
import { SkeletonFigures, SkeletonRows } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
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

  return (
    <PageBody>
      <Section>
        <Panel dashed>
          <Text className="text-sm font-medium text-foreground">
            {t('billingPage.plans.explainerTitle')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('billingPage.plans.explainerBody')}
          </Text>
        </Panel>
      </Section>

      <Section title={t('billingPage.plans.creditBalance')}>
        {isLoadingCredits ? (
          <SkeletonFigures count={3} width={96} />
        ) : (
          <FigureRow>
            <Figure
              value={(credits?.credits ?? 0).toLocaleString()}
              label={t('billingPage.plans.totalCredits')}
            />
            <Figure
              value={(credits?.freeCredits ?? 0).toLocaleString()}
              label={t('billingPage.plans.freeCredits')}
            />
            <Figure
              value={(credits?.paidCredits ?? 0).toLocaleString()}
              label={t('billingPage.plans.paidCredits')}
            />
          </FigureRow>
        )}
      </Section>

      <Section title={t('billingPage.plans.productSubscriptions')}>
        {productSubscriptions.isError ? (
          <Text className="text-sm text-destructive" accessibilityRole="alert">
            {t('billingPage.plans.productSubscriptionsError')}
          </Text>
        ) : productSubscriptions.isLoading ? (
          <Muted>{t('billingPage.plans.loadingSubscriptions')}</Muted>
        ) : sources.length === 0 ? (
          <Muted>{t('billingPage.plans.noProductSubscriptions')}</Muted>
        ) : (
          <RowList>
            {sources.map((source, index) => (
              <View
                key={source.sourceId}
                className={`gap-1 px-4 py-4 ${index === 0 ? '' : 'border-t border-border'}`}
              >
                <Text className="text-sm font-medium text-foreground">
                  {source.offers.map((offer) => offer.displayName).join(', ')}
                </Text>
                <Text className="text-sm text-foreground">
                  {t('billingPage.plans.products', {
                    products: source.offers
                      .flatMap((offer) => offer.products.map((product) => product.displayName))
                      .join(', '),
                  })}
                </Text>
                {source.offers.map((offer) => (
                  <Text key={offer.segmentId} className="text-xs text-muted-foreground">
                    {offer.displayName} ·{' '}
                    {t(
                      offer.origin === 'bundle'
                        ? 'billingPage.plans.bundle'
                        : 'billingPage.plans.individual',
                    )}{' '}
                    ·{' '}
                    {t(
                      offer.current
                        ? 'billingPage.plans.currentPeriod'
                        : 'billingPage.plans.paidHistory',
                    )}{' '}
                    · {new Date(offer.period.start).toLocaleDateString()} –{' '}
                    {new Date(offer.period.end).toLocaleDateString()}
                  </Text>
                ))}
                <Text className="text-xs text-muted-foreground">
                  {source.status} · {new Date(source.period.start).toLocaleDateString()} –{' '}
                  {new Date(source.period.end).toLocaleDateString()}
                </Text>
                {source.cancelAtPeriodEnd ? (
                  <View className="items-start pt-1">
                    <StatusBadge label={t('billingPage.plans.cancelsAtPeriodEnd')} />
                  </View>
                ) : (
                  source.canCancel && (
                    <View className="items-start pt-1">
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
                    </View>
                  )
                )}
              </View>
            ))}
          </RowList>
        )}
      </Section>

      <Section title={t('billingPage.plans.creditPlans')}>
        {creditSubscriptions.isError ? (
          <Text className="text-sm text-destructive" accessibilityRole="alert">
            {t('billingPage.plans.creditPlansError')}
          </Text>
        ) : (
          liveCreditPlans.map((plan) => (
            <View key={plan._id} className="gap-1 border-b border-border py-4">
              <Text className="text-sm text-foreground">
                {t('billingPage.plans.creditsPerMonth', {
                  name: plan.plan.name,
                  credits: plan.plan.creditsPerMonth.toLocaleString(),
                })}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('billingPage.plans.through', {
                  status: plan.status,
                  date: new Date(plan.currentPeriodEnd).toLocaleDateString(),
                })}
              </Text>
              {plan.cancelAtPeriodEnd ? (
                <View className="items-start pt-1">
                  <StatusBadge label={t('billingPage.plans.cancelsAtPeriodEnd')} />
                </View>
              ) : (
                <View className="items-start pt-1">
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
                </View>
              )}
            </View>
          ))
        )}
        {liveCreditPlans.length === 0 && !creditSubscriptions.isError && (
          <Muted>{t('billingPage.plans.freeRefresh')}</Muted>
        )}
        {liveCreditPlans.length === 0 && (
          <View className="items-start">
            <Button appearance="outline" size="sm" onPress={() => setShowUpgradeDialog(true)}>
              {t('billingPage.plans.chooseCreditPlan')}
            </Button>
          </View>
        )}
      </Section>

      <Section
        title={t('billingPage.plans.grantsTitle')}
        description={t('billingPage.plans.grantsBody')}
      >
        {creditGrants.isError ? (
          <Text className="text-sm text-destructive" accessibilityRole="alert">
            {t('billingPage.plans.grantsError')}
          </Text>
        ) : (
          grants.map((grant) => (
            <View key={grant.id} className="gap-0.5 border-b border-border py-3">
              <Text className="text-sm text-foreground">
                {grant.origin.replaceAll('_', ' ')}
                {grant.promotionId ? ` · ${grant.promotionId}` : ''}
              </Text>
              <Text className="text-xs text-foreground">
                {t('billingPage.plans.grantAmounts', {
                  granted: grant.granted.toLocaleString(),
                  consumed: grant.consumed.toLocaleString(),
                  refunded: grant.clawed.toLocaleString(),
                  remaining: grant.remaining.toLocaleString(),
                })}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('billingPage.plans.grantInvoice', {
                  invoice: grant.invoiceId,
                  start: new Date(grant.period.start).toLocaleDateString(),
                  end: new Date(grant.period.end).toLocaleDateString(),
                })}
              </Text>
            </View>
          ))
        )}
      </Section>

      <Section title={t('billingPage.plans.purchaseTitle')}>
        {isLoadingPackages ? (
          <SkeletonRows height={64} />
        ) : packages.length > 0 ? (
          <RowList>
            {packages.map((pkg, index) => (
              <Row key={pkg.id} first={index === 0}>
                <View className="gap-0.5">
                  <Text className="text-sm font-medium text-foreground">
                    {t('billingPage.plans.creditsCount', { credits: pkg.credits.toLocaleString() })}
                  </Text>
                  <Text className="text-sm text-muted-foreground">
                    ${(pkg.price / 100).toFixed(2)} {pkg.currency.toUpperCase()}
                  </Text>
                </View>
                <Button
                  appearance="outline"
                  size="sm"
                  onPress={() => handlePurchase(pkg.id)}
                  disabled={createCheckout.isPending}
                >
                  {createCheckout.isPending ? t('common.loading') : t('billingPage.plans.purchase')}
                </Button>
              </Row>
            ))}
          </RowList>
        ) : (
          <Muted>{t('billingPage.plans.noPackages')}</Muted>
        )}
      </Section>

      <Section title={t('billingPage.plans.transactions')} last>
        {isLoadingTransactions ? (
          <SkeletonRows height={48} />
        ) : transactions.length > 0 ? (
          <RowList>
            {transactions.map((tx, index) => (
              <Row key={tx._id} first={index === 0}>
                <View className="gap-0.5">
                  <Text className="text-sm font-medium text-foreground">
                    {tx.description || tx.type.replace(/_/g, ' ')}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <View className="items-end gap-0.5">
                  <Text className="text-sm font-medium text-foreground">
                    {t('billingPage.plans.plusCredits', { credits: tx.credits.toLocaleString() })}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    ${(tx.amount / 100).toFixed(2)} {tx.currency.toUpperCase()}
                  </Text>
                </View>
              </Row>
            ))}
          </RowList>
        ) : (
          <Muted>{t('billingPage.plans.noTransactions')}</Muted>
        )}
      </Section>

      <ConfirmDialog
        open={pendingCancel !== null}
        title={t('billingPage.plans.cancelTitle')}
        description={
          pendingCancel === null
            ? undefined
            : t(
                pendingCancel.kind === 'product'
                  ? 'billingPage.plans.cancelProductConfirm'
                  : 'billingPage.plans.cancelCreditConfirm',
                { name: pendingCancel.name },
              )
        }
        confirmLabel={t('billingPage.plans.cancelConfirmAction')}
        destructive
        loading={cancelNamed.isPending}
        onConfirm={handleCancel}
        onClose={() => setPendingCancel(null)}
      />

      <Dialog
        open={showUpgradeDialog}
        onClose={() => setShowUpgradeDialog(false)}
        title={t('billingPage.plans.upgradeTitle')}
        description={t('billingPage.plans.upgradeBody')}
        scrollable
        actions={[{ label: t('common.cancel'), color: 'cancel' }]}
      >
        <View className="gap-3 py-2">
          {plans.map((plan) => (
            <View
              key={plan.id}
              className="flex-row items-center justify-between gap-3 rounded-lg border border-border p-4"
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-sm font-semibold text-foreground">{plan.name}</Text>
                <Text className="text-sm text-muted-foreground">
                  {t('billingPage.plans.planCredits', {
                    credits: plan.creditsPerMonth.toLocaleString(),
                  })}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {t('billingPage.plans.planPrice', { price: (plan.price / 100).toFixed(2) })}
                </Text>
              </View>
              <Button
                size="sm"
                onPress={() => handleUpgrade(plan.id)}
                disabled={createSubscriptionCheckout.isPending}
              >
                {createSubscriptionCheckout.isPending
                  ? t('common.loading')
                  : t('billingPage.plans.subscribe')}
              </Button>
            </View>
          ))}
          {plans.length === 0 && <Muted>{t('billingPage.plans.noPlans')}</Muted>}
        </View>
      </Dialog>
    </PageBody>
  );
}
