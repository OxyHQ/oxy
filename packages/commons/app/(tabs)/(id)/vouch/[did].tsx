import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Image, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import {
  Screen,
  StackHeader,
  Section,
  Callout,
  CenteredState,
  PrimaryButton,
  SecondaryButton,
} from '@/components/ui';
import { useCivicCard } from '@/hooks/useCivicCard';
import { useVouch } from '@/hooks/useVouch';
import { userIdFromDid } from '@/lib/civic/did';
import { useTranslation } from '@/lib/i18n';

/** Default / clamp bounds for the optional stake — mirror the server's
 *  `PERSONHOOD_VOUCH_{DEFAULT,MIN,MAX}_STAKE`. The server re-clamps and is
 *  authoritative; these only seed and validate the input. */
const STAKE_DEFAULT = 10;
const STAKE_MIN = 1;
const STAKE_MAX = 100;

/**
 * Vouch confirm screen.
 *
 * Reuses the scanned subject's signed card (`useCivicCard`) for their name +
 * avatar, then walks the voucher through staking their reputation to vouch the
 * subject is a real person. The stake + slash risk are spelled out before the
 * action; the vouch itself is gated behind the device biometric (it signs a
 * `personhood_vouch` record on the voucher's own chain). On success the awarded
 * points are shown and a "Withdraw vouch" affordance is offered.
 *
 * NATIVE-ONLY (the vouch signs with the on-device key).
 */
export default function VouchScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  const { did } = useLocalSearchParams<{ did: string }>();

  const userId = useMemo(() => (did ? userIdFromDid(did) : null), [did]);
  const cardQuery = useCivicCard(userId);
  const card = cardQuery.data?.card;
  const subjectName = card?.name ?? '';

  const [stakeText, setStakeText] = useState(String(STAKE_DEFAULT));

  const { state, biometricFailed, errorCode, result, vouch, withdraw } = useVouch(
    did ?? null,
    userId,
    t('civic.vouch.confirm.biometricReason'),
  );

  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/(id)');
  }, [router]);

  const stakeAmount = useMemo(() => {
    const parsed = Number.parseInt(stakeText, 10);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(STAKE_MIN, Math.min(STAKE_MAX, parsed));
  }, [stakeText]);

  const handleVouch = useCallback(() => {
    void vouch(stakeAmount);
  }, [vouch, stakeAmount]);

  const busy = state === 'vouching' || state === 'withdrawing';

  const renderBody = () => {
    // Invalid / unparseable target.
    if (!userId || !did) {
      return (
        <CenteredState
          icon="account-alert-outline"
          title={t('civic.vouch.confirm.invalidTitle')}
          body={t('civic.vouch.confirm.invalidBody')}
        />
      );
    }

    if (state === 'done' && result) {
      return (
        <CenteredState
          icon="account-check"
          iconColor={colors.success}
          title={t('civic.vouch.confirm.done.title')}
          body={t('civic.vouch.confirm.done.body', { name: subjectName, points: result.points })}
          action={
            <View style={styles.resultActions}>
              <View style={styles.stakedChip}>
                <MaterialCommunityIcons name="lock-outline" size={15} color={colors.textSecondary} />
                <ThemedText style={[styles.stakedText, { color: colors.textSecondary }]}>
                  {t('civic.vouch.confirm.done.staked', { stake: result.stakeAmount })}
                </ThemedText>
              </View>
              <SecondaryButton
                icon="undo-variant"
                label={t('civic.vouch.confirm.withdraw')}
                onPress={withdraw}
                disabled={busy}
                fullWidth={false}
              />
              <PrimaryButton label={t('common.done')} onPress={handleClose} fullWidth={false} />
              {busy && (
                <ThemedText style={[styles.muted, { color: colors.textSecondary }]}>
                  {t('civic.vouch.confirm.withdrawing')}
                </ThemedText>
              )}
            </View>
          }
        />
      );
    }

    if (state === 'withdrawn') {
      return (
        <CenteredState
          icon="undo-variant"
          title={t('civic.vouch.confirm.withdrawn.title')}
          body={t('civic.vouch.confirm.withdrawn.body', { name: subjectName })}
          action={
            <View style={styles.action}>
              <PrimaryButton label={t('common.done')} onPress={handleClose} fullWidth={false} />
            </View>
          }
        />
      );
    }

    if (state === 'error') {
      return (
        <CenteredState
          icon="alert-circle-outline"
          iconColor={colors.error}
          title={t('civic.vouch.confirm.error.title')}
          body={t(`civic.vouch.error.${errorCode ?? 'generic'}`)}
          action={
            <View style={styles.action}>
              <PrimaryButton label={t('common.close')} onPress={handleClose} fullWidth={false} />
            </View>
          }
        />
      );
    }

    // Resolving the subject card (name/avatar) for the first time.
    if (cardQuery.isPending && !card) {
      return <CenteredState loading body={t('civic.vouch.confirm.loading')} />;
    }

    return (
      <>
        {/* Subject identity */}
        <View style={styles.identityRow}>
          {card?.avatarUrl ? (
            <Image source={{ uri: card.avatarUrl }} style={styles.avatar} resizeMode="cover" />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder, { backgroundColor: colors.border }]}>
              <Text style={[styles.avatarInitial, { color: colors.textSecondary }]}>
                {subjectName.charAt(0)?.toUpperCase() || '?'}
              </Text>
            </View>
          )}
          <View style={styles.identityText}>
            <ThemedText style={styles.name} numberOfLines={2}>
              {subjectName || t('civic.vouch.confirm.unknownPerson')}
            </ThemedText>
            {card?.username && (
              <ThemedText style={[styles.username, { color: colors.textSecondary }]} numberOfLines={1}>
                @{card.username}
              </ThemedText>
            )}
          </View>
        </View>

        <ThemedText style={[styles.intro, { color: colors.text }]}>
          {t('civic.vouch.confirm.intro', { name: subjectName || t('civic.vouch.confirm.unknownPerson') })}
        </ThemedText>

        {/* Stake input */}
        <Section title={t('civic.vouch.confirm.stakeTitle')} subtitle={t('civic.vouch.confirm.stakeHint')}>
          <View style={styles.stakeRow}>
            <MaterialCommunityIcons name="shield-star-outline" size={22} color={colors.textTertiary} />
            <ThemedText style={[styles.stakeLabel, { color: colors.text }]}>
              {t('civic.vouch.confirm.stakeLabel')}
            </ThemedText>
            <TextInput
              value={stakeText}
              onChangeText={setStakeText}
              keyboardType="number-pad"
              maxLength={3}
              editable={!busy}
              accessibilityLabel={t('civic.vouch.confirm.stakeLabel')}
              style={[styles.stakeInput, { color: colors.text, borderColor: colors.border }]}
            />
          </View>
        </Section>

        {/* Slash warning */}
        <Callout tone="warning" icon="alert-outline">
          {t('civic.vouch.confirm.slashWarning')}
        </Callout>

        {biometricFailed && (
          <ThemedText style={[styles.inlineWarn, { color: colors.warning }]}>
            {t('civic.vouch.confirm.biometricFailed')}
          </ThemedText>
        )}

        <PrimaryButton
          icon="fingerprint"
          label={t('civic.vouch.confirm.cta')}
          loading={busy}
          onPress={handleVouch}
        />

        {busy && (
          <ThemedText style={[styles.muted, styles.centerText, { color: colors.textSecondary }]}>
            {t('civic.vouch.confirm.submitting')}
          </ThemedText>
        )}
      </>
    );
  };

  return (
    <Screen gap={20}>
      <StackHeader title={t('civic.vouch.confirm.title')} onBack={handleClose} backAccessibilityLabel={t('common.back')} />
      {renderBody()}
    </Screen>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    marginTop: 4,
  },
  resultActions: {
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 24,
    fontWeight: '600',
  },
  identityText: {
    flex: 1,
  },
  name: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  username: {
    fontSize: 14,
    marginTop: 2,
  },
  intro: {
    fontSize: 15,
    lineHeight: 21,
  },
  stakeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  stakeLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },
  stakeInput: {
    minWidth: 64,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  inlineWarn: {
    fontSize: 13,
    lineHeight: 18,
  },
  muted: {
    fontSize: 14,
    lineHeight: 20,
  },
  centerText: {
    textAlign: 'center',
  },
  stakedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stakedText: {
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
