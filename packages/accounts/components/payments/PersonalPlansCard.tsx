import { useState, useRef, useLayoutEffect } from 'react';
import { randomUUID } from 'expo-crypto';
import { View, Pressable, Linking } from 'react-native';
import { authenticatedApiCall } from '@oxy.so/core';
import { oxyAccountIdSchema } from '@oxy.so/contracts';
import {
  useOxy,
  usePersonalPlans,
  usePersonalPlanSubscriptions,
  DisplayCurrencySelector,
  useDisplayPrice,
} from '@oxy.so/services';
import { Section } from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { useTranslation } from '@/lib/i18n';
import {
  getPersonalPlanCheckoutKey,
  clearPersonalPlanCheckoutKey,
} from '@/lib/personal-plan-checkout';

/** Remount confirmation state on every account/session change. */
export function PersonalPlansCard() {
  const { user, activeSessionId } = useOxy();
  return <PersonalPlansContent key={`${user?.id}:${activeSessionId}`} />;
}

function PersonalPlansContent() {
  const { oxyServices, user, activeSessionId, isAuthenticated } = useOxy();
  const { t, locale } = useTranslation();
  const catalogue = usePersonalPlans();
  const display = useDisplayPrice();
  const sources = usePersonalPlanSubscriptions();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useRef(new Map<string, string>());
  const [message, setMessage] = useState('');
  const [paymentReview, setPaymentReview] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState(false);
  const scope = useRef({ active: false });
  useLayoutEffect(() => {
    const current = { active: isAuthenticated };
    scope.current = current;
    return () => {
      current.active = false;
    };
  }, [user?.id, activeSessionId, isAuthenticated]);
  const captureScope = () => {
    const current = scope.current;
    return () => current.active && scope.current === current;
  };
  async function purchase(offerId: string, offerVersion: number) {
    if (!user?.id || !isAuthenticated || busy) return;
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    setBusy(true);
    setMessage('');
    setPaymentReview(false);
    try {
      const idempotencyKey = await getPersonalPlanCheckoutKey(user.id, offerId, offerVersion);
      if (!isCurrent()) return;
      const result = await authenticatedApiCall(oxyServices, activeSessionId, () => {
        if (!isCurrent()) throw new Error('Account changed');
        return oxyServices.billing.startPersonalPlanCheckout({
          expectedSubjectAccountId: oxyAccountIdSchema.parse(user.id),
          offerId,
          offerVersion,
          idempotencyKey,
        });
      });
      if (!isCurrent()) return;
      if (result.state === 'pending' && result.checkoutUrl) {
        const url = new URL(result.checkoutUrl);
        url.searchParams.set('displayCurrency', display.currency);
        await Linking.openURL(url.toString());
      } else if (result.state === 'closed' || result.state === 'fulfilled') {
        await clearPersonalPlanCheckoutKey(user.id, offerId, offerVersion);
        if (!isCurrent()) return;
        await sources.refetch();
        if (!isCurrent()) return;
        setMessage(
          t(`payments.one.${result.state === 'fulfilled' ? 'checkoutComplete' : 'checkoutClosed'}`),
        );
      } else
        setMessage(
          t(`payments.one.${result.state === 'unconfigured' ? 'unconfigured' : 'pending'}`),
        );
    } catch (error) {
      if (isCurrent()) {
        const needsReview =
          error instanceof Error &&
          (error.message === 'PAYMENT_REVIEW_REQUIRED' ||
            ('code' in error && error.code === 'PAYMENT_REVIEW_REQUIRED'));
        setPaymentReview(needsReview);
        setMessage(t(needsReview ? 'payments.one.paymentReview' : 'payments.one.checkoutFailed'));
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function renew(sourceId: string, periodEnd: string) {
    if (!user?.id || !isAuthenticated || busy) return;
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    setBusy(true);
    setMessage('');
    setPaymentReview(false);
    const operation = `renew:${sourceId}:${periodEnd}`;
    try {
      const idempotencyKey = await getPersonalPlanCheckoutKey(user.id, operation, 1);
      if (!isCurrent()) return;
      const result = await authenticatedApiCall(oxyServices, activeSessionId, () => {
        if (!isCurrent()) throw new Error('Account changed');
        return oxyServices.billing.renewProductSubscription({
          expectedSubjectAccountId: oxyAccountIdSchema.parse(user.id),
          sourceId,
          idempotencyKey,
        });
      });
      if (!isCurrent()) return;
      if (result.state === 'pending' && result.checkoutUrl) {
        const url = new URL(result.checkoutUrl);
        url.searchParams.set('displayCurrency', display.currency);
        await Linking.openURL(url.toString());
      } else if (result.state === 'fulfilled' || result.state === 'closed') {
        await clearPersonalPlanCheckoutKey(user.id, operation, 1);
        if (!isCurrent()) return;
        await sources.refetch();
        if (!isCurrent()) return;
        setMessage(
          t(`payments.one.${result.state === 'fulfilled' ? 'checkoutComplete' : 'checkoutClosed'}`),
        );
      } else
        setMessage(
          t(`payments.one.${result.state === 'unconfigured' ? 'unconfigured' : 'pending'}`),
        );
    } catch (error) {
      if (isCurrent()) {
        const needsReview =
          error instanceof Error &&
          (error.message === 'PAYMENT_REVIEW_REQUIRED' ||
            ('code' in error && error.code === 'PAYMENT_REVIEW_REQUIRED'));
        setPaymentReview(needsReview);
        setMessage(t(needsReview ? 'payments.one.paymentReview' : 'payments.one.checkoutFailed'));
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function cancel(sourceId: string) {
    if (!user?.id || !isAuthenticated || busy) return;
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const actionId = actions.current.get(sourceId) ?? randomUUID();
    actions.current.set(sourceId, actionId);
    setBusy(true);
    setRefreshWarning(false);
    let confirmed = false;
    try {
      const result = await authenticatedApiCall(oxyServices, activeSessionId, () => {
        if (!isCurrent()) throw new Error('Account changed');
        return oxyServices.billing.cancelProductSubscriptionWithStatus(sourceId, user.id, actionId);
      });
      if (!isCurrent()) return;
      setMessage(t(`payments.one.${'reconciliationPending' in result ? 'pending' : 'scheduled'}`));
      actions.current.delete(sourceId);
      setConfirm(null);
      confirmed = true;
    } catch {
      if (isCurrent()) setMessage(t('payments.one.failed'));
    }
    // A failed list refresh never turns a confirmed cancellation into a failure.
    if (confirmed && isCurrent()) {
      try {
        await sources.refetch();
      } catch {
        if (isCurrent()) setRefreshWarning(true);
      }
    }
    if (isCurrent()) setBusy(false);
  }
  return (
    <Section title="Oxy One">
      <View style={{ gap: 12, padding: 16 }}>
        <ThemedText>{t('payments.one.description')}</ThemedText>
        <DisplayCurrencySelector />
        {catalogue.isPending ? (
          <ThemedText>{t('payments.one.loading')}</ThemedText>
        ) : catalogue.isError ? (
          <ThemedText>{t('payments.one.unavailable')}</ThemedText>
        ) : (
          <>
            {catalogue.data?.plans.map((plan) => (
              <View key={`${plan.offerId}@${plan.offerVersion}`}>
                <ThemedText>
                  {plan.displayName} · v{plan.offerVersion}
                </ThemedText>
                {plan.price && (
                  <>
                    <ThemedText>
                      {t('payments.one.monthlyPrice', {
                        price:
                          plan.price.currency.toUpperCase() === 'USD'
                            ? display.formatUsd(plan.price.amountMinorUnits)
                            : formatPersonalPlanPrice(plan.price, locale),
                      })}
                    </ThemedText>
                    {display.currency !== 'USD' && (
                      <ThemedText>{formatPersonalPlanPrice(plan.price, locale)}</ThemedText>
                    )}
                    <ThemedText>{t('payments.one.noTrial')}</ThemedText>
                    <ThemedText>{t('payments.one.finalTaxInclusive')}</ThemedText>
                  </>
                )}
                {String(catalogue.data?.purchase) === 'available' && isAuthenticated && (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => purchase(plan.offerId, plan.offerVersion)}
                  >
                    <ThemedText>{t('payments.one.checkout')}</ThemedText>
                  </Pressable>
                )}
                {plan.benefits.map(({ displayName, benefit }) => (
                  <ThemedText key={`${benefit.productId}:${benefit.key}:${displayName}`}>
                    {displayName}
                    {benefit.kind === 'quota'
                      ? ` · ${benefit.included.toLocaleString()} ${benefit.unit}`
                      : ''}
                  </ThemedText>
                ))}
              </View>
            ))}
            {catalogue.data?.purchase === 'unavailable' && (
              <ThemedText>{t('payments.one.unconfigured')}</ThemedText>
            )}
          </>
        )}
        {isAuthenticated &&
          (sources.isPending ? (
            <ThemedText>{t('payments.one.loading')}</ThemedText>
          ) : sources.isError ? (
            <ThemedText>{t('payments.one.sourceError')}</ThemedText>
          ) : sources.data?.length ? (
            sources.data.map((source) => (
              <View key={source.sourceId} style={{ gap: 8 }}>
                <ThemedText>
                  {source.status} ·{' '}
                  {source.cancelAtPeriodEnd ? t('payments.one.ends') : t('payments.one.period')}{' '}
                  {source.period.end.slice(0, 10)}
                </ThemedText>
                {source.offers.map((offer) => (
                  <ThemedText key={offer.segmentId}>
                    {offer.displayName} · v{offer.offerVersion} · {offer.origin} ·{' '}
                    {offer.current ? t('payments.one.current') : t('payments.one.history')}
                  </ThemedText>
                ))}
                {source.canRenew && (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => renew(source.sourceId, source.period.end)}
                  >
                    <ThemedText>{t('payments.one.renew')}</ThemedText>
                  </Pressable>
                )}
                {source.canCancel &&
                  !source.cancelAtPeriodEnd &&
                  (confirm === source.sourceId ? (
                    <>
                      <ThemedText>{t('payments.one.confirm')}</ThemedText>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => cancel(source.sourceId)}
                      >
                        <ThemedText>{t('payments.one.confirmCancel')}</ThemedText>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => {
                          actions.current.delete(source.sourceId);
                          setConfirm(null);
                        }}
                      >
                        <ThemedText>{t('payments.one.keep')}</ThemedText>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setConfirm(source.sourceId)}
                    >
                      <ThemedText>{t('payments.one.cancel')}</ThemedText>
                    </Pressable>
                  ))}
              </View>
            ))
          ) : (
            <ThemedText>{t('payments.one.noSources')}</ThemedText>
          ))}
        {!!message && <ThemedText accessibilityLiveRegion="polite">{message}</ThemedText>}
        {paymentReview && (
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL('https://peable.to')}>
            <ThemedText>{t('payments.one.reviewPayment')}</ThemedText>
          </Pressable>
        )}
        {refreshWarning && <ThemedText>{t('payments.one.refreshFailed')}</ThemedText>}
      </View>
    </Section>
  );
}

/** Currency precision comes from Intl; catalogue amounts are integer minor units. */
export function formatPersonalPlanPrice(
  price: { currency: string; amountMinorUnits: number },
  locale: string,
): string {
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(price.amountMinorUnits / 10 ** digits);
}
