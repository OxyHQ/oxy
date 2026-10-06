import React, { useState,useRef } from 'react';
import {randomUUID} from 'expo-crypto';
import { View, Pressable } from 'react-native';
import { authenticatedApiCall } from '@oxy.so/core';
import { useOxy, usePersonalPlans, usePersonalPlanSubscriptions } from '@oxy.so/services';
import { Section } from '@/components/section';
import { ThemedText } from '@/components/themed-text';
import { useTranslation } from '@/lib/i18n';

/** Remount confirmation state on every account/session change. */
export function PersonalPlansCard() {
  const { user, activeSessionId } = useOxy();
  return <PersonalPlansContent key={`${user?.id}:${activeSessionId}`} />;
}

function PersonalPlansContent() {
  const { oxyServices, user, activeSessionId, isAuthenticated } = useOxy();
  const { t, locale } = useTranslation();
  const catalogue = usePersonalPlans();
  const sources = usePersonalPlanSubscriptions();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actions=useRef(new Map<string,string>());
  const [message, setMessage] = useState('');
  const [refreshWarning, setRefreshWarning] = useState(false);
  async function cancel(sourceId: string) {
    if (!user?.id || !isAuthenticated || busy) return;
    const actionId=actions.current.get(sourceId)??randomUUID();actions.current.set(sourceId,actionId);
    setBusy(true); setRefreshWarning(false);
    let confirmed = false;
    try {
      const result = await authenticatedApiCall(oxyServices, activeSessionId,
        () => oxyServices.billing.cancelProductSubscriptionWithStatus(sourceId, user.id,actionId));
      setMessage(t(`payments.one.${'reconciliationPending' in result ? 'pending' : 'scheduled'}`));
      actions.current.delete(sourceId);
      setConfirm(null);
      confirmed = true;
    } catch {
      setMessage(t('payments.one.failed'));
    }
    // A failed list refresh never turns a confirmed cancellation into a failure.
    if (confirmed) {
      try { await sources.refetch(); } catch { setRefreshWarning(true); }
    }
    setBusy(false);
  }
  return <Section title="Oxy One">
    <View style={{ gap: 12, padding: 16 }}>
      <ThemedText>{t('payments.one.description')}</ThemedText>
      {catalogue.isPending ? <ThemedText>{t('payments.one.loading')}</ThemedText>
        : catalogue.isError ? <ThemedText>{t('payments.one.unavailable')}</ThemedText>
        : <>
          {catalogue.data?.plans.map(plan => <View key={`${plan.offerId}@${plan.offerVersion}`}>
            <ThemedText>{plan.displayName} · v{plan.offerVersion}</ThemedText>
            {plan.price && <>
              <ThemedText>{t('payments.one.monthlyPrice', { price: formatPersonalPlanPrice(plan.price, locale) })}</ThemedText>
              <ThemedText>{t('payments.one.noTrial')}</ThemedText>
              <ThemedText>{t('payments.one.finalTaxInclusive')}</ThemedText>
            </>}
            {plan.benefits.map(({ displayName, benefit }) => <ThemedText key={`${benefit.productId}:${benefit.key}:${displayName}`}>
              {displayName}{benefit.kind === 'quota' ? ` · ${benefit.included.toLocaleString()} ${benefit.unit}` : ''}
            </ThemedText>)}
          </View>)}
          <ThemedText>{t('payments.one.unconfigured')}</ThemedText>
        </>}
      {isAuthenticated && (sources.isPending ? <ThemedText>{t('payments.one.loading')}</ThemedText>
        : sources.isError ? <ThemedText>{t('payments.one.sourceError')}</ThemedText>
        : sources.data?.length ? sources.data.map(source => <View key={source.sourceId} style={{ gap: 8 }}>
          <ThemedText>{source.status} · {source.cancelAtPeriodEnd ? t('payments.one.ends') : t('payments.one.period')} {source.period.end.slice(0, 10)}</ThemedText>
          {source.offers.map(offer => <ThemedText key={offer.segmentId}>
            {offer.displayName} · v{offer.offerVersion} · {offer.origin} · {offer.current ? t('payments.one.current') : t('payments.one.history')}
          </ThemedText>)}
          {source.canCancel && !source.cancelAtPeriodEnd && <>
            {confirm === source.sourceId ? <>
              <ThemedText>{t('payments.one.confirm')}</ThemedText>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => cancel(source.sourceId)}><ThemedText>{t('payments.one.confirmCancel')}</ThemedText></Pressable>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => {actions.current.delete(source.sourceId);setConfirm(null);}}><ThemedText>{t('payments.one.keep')}</ThemedText></Pressable>
            </> : <Pressable accessibilityRole="button" onPress={() => setConfirm(source.sourceId)}><ThemedText>{t('payments.one.cancel')}</ThemedText></Pressable>}
          </>}
        </View>) : <ThemedText>{t('payments.one.noSources')}</ThemedText>)}
      {!!message && <ThemedText accessibilityLiveRegion="polite">{message}</ThemedText>}
      {refreshWarning && <ThemedText>{t('payments.one.refreshFailed')}</ThemedText>}
    </View>
  </Section>;
}

/** Currency precision comes from Intl; catalogue amounts are integer minor units. */
export function formatPersonalPlanPrice(price: { currency: string; amountMinorUnits: number }, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(price.amountMinorUnits / 10 ** digits);
}
