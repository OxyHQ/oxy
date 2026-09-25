import React, { useCallback, useMemo } from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { Admonition } from '@oxy.so/bloom/admonition';
import { bloomToneFor } from '@/lib/civic/card-presentation';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Button } from '@oxy.so/bloom/button';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Icons } from '@/constants/icons';
import { useColors } from '@/hooks/useColors';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import {
  Screen,
  StackHeader,
  SessionGate,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
import { useMyPersonhood } from '@/hooks/usePersonhood';
import { useCivicProfileState } from '@/hooks/useCivicProfileState';
import { useTranslation } from '@/lib/i18n';

/**
 * The personhood verification threshold θ — a score `>= θ` is a "verified real
 * person". Mirrors the server's `PERSONHOOD_THRESHOLD`; the server remains
 * authoritative (`isRealPerson` is computed there), this only positions the
 * progress marker.
 */
const PERSONHOOD_THRESHOLD = 0.6;

/**
 * "Proof of personhood" — the current user's own personhood status.
 *
 * Reads the recomputable snapshot via `getMyPersonhood()` (offline-first, like
 * the other civic surfaces). Surfaces a clear verified / building state, the
 * score as a flat progress bar with the θ threshold marked, a human breakdown of
 * the three signals (vouches, real-life confirmations, biometric binding) with
 * their counts, and plain guidance on how to raise it. Loading / empty / error
 * states are all handled; the zeroed `unverified` shape renders as "building
 * trust" rather than an error.
 */
export default function PersonhoodScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();

  const statusQuery = useMyPersonhood();
  const status = statusQuery.data;
  const { isOnline } = useCivicProfileState({ subject: 'remote' });

  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(settings)');
  }, [router]);

  const scorePct = useMemo(
    () => (status ? Math.max(0, Math.min(100, Math.round(status.score * 100))) : 0),
    [status],
  );
  const thresholdPct = Math.round(PERSONHOOD_THRESHOLD * 100);

  const renderBody = () => {
    if (statusQuery.isPending && !status) {
      return <LoadingState description={t('civic.personhood.loading')} />;
    }

    if (statusQuery.isError && !status) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.personhood.error.title')}
          description={t('civic.personhood.error.body')}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={() => statusQuery.refetch()}>{t('common.retry')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    if (!status) return null;

    const verified = status.isRealPerson;
    const fillColor = verified ? colors.success : colors.tint;

    return (
      <>
        <View style={styles.topBlock}>
          {!isOnline && (
            <Badge
              appearance="subtle"
              tone="neutral"
              size="label-small"
              icon={Icons.offline}
              content={t('civic.personhood.offline')}
            />
          )}

          {/* Verified / building hero — flat, no card. */}
          <View style={styles.hero}>
          <Badge
            appearance="subtle"
            tone={bloomToneFor(verified ? 'positive' : 'caution')}
            size="label-medium"
            icon={Icons[verified ? 'vouched' : 'pending']}
            content={t(verified ? 'civic.personhood.verifiedBadge' : 'civic.personhood.buildingBadge')}
          />

          <View className="gap-space-4">
            <Text style={[styles.scoreValue, { color: colors.text }]}>
              {t('civic.personhood.scoreValue', { pct: scorePct })}
            </Text>
            <Text style={[styles.scoreLabel, { color: colors.textSecondary }]}>
              {t('civic.personhood.scoreLabel')}
            </Text>
          </View>

          {/* Progress to the θ threshold */}
          <View style={styles.progressBlock}>
            <View style={[styles.track, { backgroundColor: `${fillColor}1F` }]}>
              <View style={[styles.fill, { width: `${scorePct}%`, backgroundColor: fillColor }]} />
              <View style={[styles.thresholdMark, { left: `${thresholdPct}%`, backgroundColor: colors.text }]} />
            </View>
            <Text style={[styles.thresholdLabel, { color: colors.textSecondary }]}>
              {t('civic.personhood.thresholdLabel', { pct: thresholdPct })}
            </Text>
          </View>

          <Text style={[styles.heroDesc, { color: colors.textSecondary }]}>
            {t(verified ? 'civic.personhood.verifiedDesc' : 'civic.personhood.buildingDesc')}
          </Text>
        </View>

          {status.sybilPenalty > 0 && (
            <Admonition type="warning">
              {t('civic.personhood.penaltyNote')}
            </Admonition>
          )}
        </View>

        {/* Signals */}
        <SettingsListGroup
          title={t('civic.personhood.signals.title')}
          footer={t('civic.personhood.signals.subtitle')}
        >
          <SettingsListItem
            icon={<Icons.community size='md' fill={colors.text} />}
            title={t('civic.personhood.signals.vouches')}
            description={t('civic.personhood.signals.vouchesDesc')}
            value={t('civic.personhood.signals.vouchesCount', { count: status.vouchCount })}
          />
          <SettingsListItem
            icon={<Icons.handshake size='md' fill={colors.text} />}
            title={t('civic.personhood.signals.realLife')}
            description={t('civic.personhood.signals.realLifeDesc')}
            value={t('civic.personhood.signals.realLifeCount', { count: status.realLifeCount })}
          />
          <SettingsListItem
            icon={<Icons.personhood size='md' fill={colors.text} />}
            title={t('civic.personhood.signals.biometric')}
            description={t('civic.personhood.signals.biometricDesc')}
            value={status.biometricBound ? undefined : t('civic.personhood.signals.biometricUnbound')}
            rightElement={
              status.biometricBound ? (
                <Text style={[styles.boundValue, { color: colors.success }]}>
                  {t('civic.personhood.signals.biometricBound')}
                </Text>
              ) : undefined
            }
          />
        </SettingsListGroup>

        {/* How to increase it */}
        <SettingsListGroup
          title={t('civic.personhood.improve.title')}
          footer={t('civic.personhood.improve.subtitle')}
        >
          <SettingsListItem
            icon={<Icons.vouched size='md' fill={colors.text} />}
            title={t('civic.personhood.improve.getVouched')}
            description={t('civic.personhood.improve.getVouchedDesc')}
            showChevron={false}
          />
          <SettingsListItem
            icon={<Icons.handshake size='md' fill={colors.text} />}
            title={t('civic.personhood.improve.doRealLife')}
            description={t('civic.personhood.improve.doRealLifeDesc')}
            showChevron={false}
          />
          <SettingsListItem
            icon={<Icons.personhood size='md' fill={colors.text} />}
            title={t('civic.personhood.improve.bindBiometric')}
            description={t('civic.personhood.improve.bindBiometricDesc')}
            showChevron={false}
          />
        </SettingsListGroup>

        <View style={styles.gutter}>
          <Text style={[styles.footnote, { color: colors.textSecondary }]}>
            {t('civic.personhood.footnote')}
          </Text>
        </View>
      </>
    );
  };

  return (
    // Flush column — Bloom's SettingsListGroup owns its horizontal gutter; the
    // header and custom hero content are padded to align with it.
    <Screen contentStyle={styles.flush} gap={16}>
      <View style={styles.header}>
        <StackHeader
          title={t('civic.personhood.title')}
          onBack={handleClose}
          backAccessibilityLabel={t('common.back')}
        />
      </View>
      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flush: { paddingHorizontal: 0 },
  header: { paddingHorizontal: 20, marginBottom: 16 },
  gutter: { paddingHorizontal: 20 },
  topBlock: {
    paddingHorizontal: 20,
    gap: 18,
  },
  boundValue: {
    fontSize: 13,
    lineHeight: 17,
  },
  hero: {
    gap: 18,
    alignItems: 'flex-start',
  },
  scoreValue: {
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  scoreLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  progressBlock: {
    width: '100%',
    gap: 8,
  },
  track: {
    width: '100%',
    height: 8,
    borderRadius: 999,
    overflow: 'hidden',
    position: 'relative',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 999,
  },
  thresholdMark: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    width: 2,
    opacity: 0.55,
  },
  thresholdLabel: {
    fontSize: 12,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  heroDesc: {
    fontSize: 14,
    lineHeight: 20,
  },
  footnote: {
    fontSize: 12,
    lineHeight: 18,
  },
});
