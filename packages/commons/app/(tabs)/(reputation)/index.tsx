import React, { useCallback, useMemo, useState } from 'react';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Text } from '@oxy.so/bloom/typography';
import { Icons } from '@/constants/icons';
import { Loading } from '@oxy.so/bloom/loading';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { View, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services';
import { ActivityHeatmap } from '@oxy.so/bloom/activity-heatmap';
import { useColors } from '@/hooks/useColors';
import {
  Screen,
  SessionGate,
} from '@/components/ui';
import { AttestQrSheet } from '@/components/civic/AttestQrSheet';
import { ReputationHeader } from '@/components/reputation/ReputationHeader';
import { GetStartedCarousel, type CtaItem } from '@/components/reputation/GetStartedCarousel';
import { StandingSection } from '@/components/reputation/StandingSection';
import { ActivityList } from '@/components/reputation/ActivityList';
import { useCivicReputation, useReputationSources } from '@/hooks/useCivicReputation';
import { useReputationActivity } from '@/hooks/useReputationActivity';
import { useReputationHeatmap } from '@/hooks/useReputationHeatmap';
import { useValidatorInbox } from '@/hooks/useValidatorInbox';
import { useCivicProfileState } from '@/hooks/useCivicProfileState';
import { useTranslation } from '@/lib/i18n';

/** The two content sections behind the segmented tabs. */
type ReputationTab = 'overview' | 'activity';

/**
 * Reputation — a fintech-dashboard surface.
 *
 * A big page title with a floating civic-duty shortcut, a dismissible "Get
 * started" carousel of the civic duties that grow standing (get attested,
 * validate others, prove personhood), and a segmented Overview / Activity
 * switch. Overview leads with the "Standing" card (lifetime total, trust tier,
 * a stacked composition bar and its category breakdown, plus influence /
 * reliability); Activity is the signed ledger feed. Data is unchanged — the
 * balance comes from `useCivicReputation`, the four sources are derived
 * client-side, and recent entries from `useReputationActivity`. Offline-first
 * via the shared `civic`-namespaced React Query cache.
 */
export default function ReputationScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { user, oxyServices } = useOxy();
  const { isOnline } = useCivicProfileState({ subject: 'remote' });

  const [tab, setTab] = useState<ReputationTab>('overview');
  const [getStartedDismissed, setGetStartedDismissed] = useState(false);

  const userId = user?.id ?? oxyServices?.getCurrentUserId() ?? null;
  const balanceQuery = useCivicReputation(userId);
  const balance = balanceQuery.data;
  const sources = useReputationSources(balance);

  const activityQuery = useReputationActivity(userId);
  const heatmapQuery = useReputationHeatmap(userId);
  const inboxQuery = useValidatorInbox();
  const pendingValidations = inboxQuery.data?.length ?? 0;

  // Anchor the heatmap grid to "today". The Bloom component never reads the
  // system clock, so the screen supplies the endpoint as a `YYYY-MM-DD` string.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const monthLabels = useMemo(
    () => Array.from({ length: 12 }, (_, month) => t(`civic.reputation.activity.months.${month}`)),
    [t],
  );
  const weekdayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, day) => t(`civic.reputation.activity.weekdays.${day}`)),
    [t],
  );

  const handleOpenInbox = useCallback(() => {
    router.push('/(tabs)/(reputation)/validate');
  }, [router]);

  // Show A's fresh attestation QR as a bottom sheet (over this tab) — a
  // counterparty scans it to confirm they met A in person.
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const handleAttest = useCallback(() => setQrSheetOpen(true), []);

  const handlePersonhood = useCallback(() => {
    router.push('/(tabs)/(settings)/personhood');
  }, [router]);

  const ctaItems = useMemo<CtaItem[]>(
    () => [
      {
        key: 'attest',
        icon: 'handshake',
        color: colors.success,
        title: t('civic.reputation.cta.attest.title'),
        description: t('civic.reputation.cta.attest.desc'),
        onPress: handleAttest,
      },
      {
        key: 'validate',
        icon: 'validation',
        color: colors.primary,
        title: t('civic.reputation.cta.validate.title'),
        description:
          pendingValidations > 0
            ? t('civic.validate.inboxEntryCount', { count: pendingValidations })
            : t('civic.reputation.cta.validate.desc'),
        onPress: handleOpenInbox,
      },
      {
        key: 'personhood',
        icon: 'endorsed',
        color: colors.info,
        title: t('civic.reputation.cta.personhood.title'),
        description: t('civic.reputation.cta.personhood.desc'),
        onPress: handlePersonhood,
      },
    ],
    [colors, t, pendingValidations, handleAttest, handleOpenInbox, handlePersonhood],
  );

  const tabItems: { key: ReputationTab; label: string }[] = [
    { key: 'overview', label: t('civic.reputation.tabs.overview') },
    { key: 'activity', label: t('civic.reputation.tabs.activity') },
  ];

  const header = (
    <ReputationHeader
      title={t('civic.reputation.title')}
      pendingCount={pendingValidations}
      onOpenDuty={handleOpenInbox}
    />
  );

  const renderContent = () => {
    if (balanceQuery.isPending && !balance) {
      return <EmptyState
               illustration={<Loading variant="spinner" size="lg" />}
               description={t('civic.reputation.loading')}
               minHeight={360}
             />;
    }

    if (balanceQuery.isError && !balance) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.reputation.error.title')}
          description={t('civic.reputation.error.body')}
          action={{ label: t('common.retry'), onPress: () => balanceQuery.refetch() }}
          minHeight={360}
        />
      );
    }

    if (!balance || !sources) {
      return null;
    }

    return (
      <>
        {!getStartedDismissed && (
          <GetStartedCarousel
            title={t('civic.reputation.getStarted.title')}
            dismissLabel={t('civic.reputation.getStarted.dismiss')}
            items={ctaItems}
            onDismiss={() => setGetStartedDismissed(true)}
          />
        )}

        {/* `type="tabs"`, not `"radio"`: these switch the panel below rather
            than choosing a value to submit, and Bloom's own note on this family
            is that the two look identical and ANNOUNCE differently — a tablist
            against a radiogroup — so `type` is the decision, not the styling. */}
        <SegmentedControl<ReputationTab>
          type="tabs"
          label={t('civic.reputation.tabs.overview')}
          value={tab}
          onValueChange={setTab}
        >
          {tabItems.map((item) => (
            <SegmentedControlItem key={item.key} value={item.key}>
              <SegmentedControlItemText>{item.label}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>

        {tab === 'overview' ? (
          <View className="gap-space-20">
            <StandingSection balance={balance} sources={sources} isOffline={!isOnline} />

            <View className="gap-space-12">
              <Text style={[styles.heatmapTitle, { color: colors.text }]}>
                {t('civic.reputation.activity.heatmapTitle')}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.heatmapScroll}
              >
                <ActivityHeatmap
                  data={heatmapQuery.data ?? []}
                  endDate={today}
                  monthLabels={monthLabels}
                  weekdayLabels={weekdayLabels}
                />
              </ScrollView>
            </View>

            <Text style={[styles.footnote, { color: colors.textSecondary }]}>
              {t('civic.reputation.footnote')}
            </Text>
          </View>
        ) : (
          <ActivityList
            transactions={activityQuery.data}
            isLoading={activityQuery.isPending}
            isError={activityQuery.isError}
          />
        )}
      </>
    );
  };

  return (
    <>
      <Screen gap={24}>
        {header}
        <SessionGate>{renderContent()}</SessionGate>
      </Screen>
      {qrSheetOpen && <AttestQrSheet onClose={() => setQrSheetOpen(false)} />}
    </>
  );
}

const styles = StyleSheet.create({
  heatmapTitle: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  heatmapScroll: {
    paddingBottom: 4,
  },
  footnote: {
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 2,
  },
});
