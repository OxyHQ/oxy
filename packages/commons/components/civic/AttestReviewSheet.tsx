import React, { useEffect, useMemo } from 'react';
import { View, Image, StyleSheet, ActivityIndicator } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Dialog, useDialogControl, type DialogAction } from '@oxyhq/bloom/dialog';
import type { PublicCard, CardTrustTier, RealLifeAttestationResult } from '@oxyhq/contracts';
import { trustTierLabel } from '@oxyhq/core';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { CenteredState } from '@/components/ui/centered-state';
import { CivicBadge } from '@/components/civic/CivicBadge';
import { getTrustTierMeta } from '@/lib/civic/card-presentation';
import type { AttestErrorCode } from '@/lib/civic/civic-errors';
import type { MaterialCommunityIconName } from '@/types/icons';
import { useTranslation } from '@/lib/i18n';

/** The confirm-lane statuses this sheet renders (a subset of AttestFlowStatus). */
export type AttestReviewStatus = 'reviewing' | 'submitting' | 'done' | 'error';

interface AttestReviewSheetProps {
  status: AttestReviewStatus;
  /** A's resolved public card (name/avatar/tier); null while resolving. */
  card: PublicCard | null;
  /** Whether A's card attestation verified (untrusted cards render a warning). */
  verified: boolean;
  /** True when A's card lookup itself failed. */
  subjectFailed: boolean;
  result: RealLifeAttestationResult | null;
  errorCode: AttestErrorCode | null;
  /** B tapped "Confirm we met" — the parent runs the biometric gate + submit. */
  onConfirm: () => void;
  /** B is running the biometric gate (disables the confirm button). */
  confirming?: boolean;
  /** Cancel / dismiss / retry — any exit returns to the live camera. */
  onClose: () => void;
}

const TIER_ICON: Record<CardTrustTier, MaterialCommunityIconName> = {
  restricted: 'alert-octagon-outline',
  new: 'account-outline',
  trusted: 'shield-check-outline',
  high_trust: 'shield-star-outline',
  verified: 'check-decagram',
};

/**
 * B's review + confirm bottom sheet for a real-life attestation.
 *
 * Replaces the old auto-submit: after B scans A's fresh attest QR, this sheet
 * shows A's server-resolved public card (DNI + reputation tier) so B can confirm
 * they actually met A in person BEFORE anything is signed. The QR carried a
 * single-use nonce, so nothing here is trusted for display — only the DID it
 * resolves to. Tapping "Confirm we met" runs a device biometric gate (in the
 * parent) then signs + submits; any dismissal cancels and returns to the camera.
 */
export function AttestReviewSheet({
  status,
  card,
  verified,
  subjectFailed,
  result,
  errorCode,
  onConfirm,
  confirming = false,
  onClose,
}: AttestReviewSheetProps) {
  const colors = useColors();
  const { t, locale } = useTranslation();
  const control = useDialogControl();

  useEffect(() => {
    control.open();
  }, [control]);

  const initial = useMemo(() => (card?.name?.trim()?.[0] ?? '?').toUpperCase(), [card?.name]);

  const body = () => {
    if (status === 'submitting') {
      return (
        <View style={styles.stateBlock}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.stateBody, { color: colors.textSecondary }]}>
            {t('civic.attest.review.submitting')}
          </ThemedText>
        </View>
      );
    }

    if (status === 'done' && result) {
      return (
        <View style={styles.stateBlock}>
          <MaterialCommunityIcons name="check-decagram" size={64} color={colors.success} />
          <ThemedText style={[styles.stateTitle, { color: colors.text }]}>
            {t('civic.attest.confirm.done.title')}
          </ThemedText>
          <ThemedText style={[styles.stateBody, { color: colors.textSecondary }]}>
            {t('civic.attest.confirm.done.body', { name: card?.name ?? '', points: result.points })}
          </ThemedText>
        </View>
      );
    }

    if (status === 'error') {
      return (
        <View style={styles.stateBlock}>
          <MaterialCommunityIcons name="alert-circle-outline" size={64} color={colors.error} />
          <ThemedText style={[styles.stateTitle, { color: colors.text }]}>
            {t('civic.attest.confirm.error.title')}
          </ThemedText>
          <ThemedText style={[styles.stateBody, { color: colors.textSecondary }]}>
            {t(`civic.attest.error.${errorCode ?? 'generic'}`)}
          </ThemedText>
        </View>
      );
    }

    // reviewing
    if (subjectFailed) {
      return (
        <CenteredState
          icon="account-alert-outline"
          title={t('civic.attest.review.unresolvedTitle')}
          body={t('civic.attest.review.unresolvedBody')}
        />
      );
    }

    if (!card) {
      return (
        <View style={styles.stateBlock}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.stateBody, { color: colors.textSecondary }]}>
            {t('civic.attest.review.resolving')}
          </ThemedText>
        </View>
      );
    }

    return (
      <View style={styles.reviewBlock}>
        <ThemedText style={[styles.heading, { color: colors.text }]}>
          {t('civic.attest.review.title')}
        </ThemedText>

        {/* A's DNI: avatar + name + handle + trust tier */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {card.avatarUrl ? (
            <Image source={{ uri: card.avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colors.tint }]}>
              <ThemedText style={styles.avatarInitial}>{initial}</ThemedText>
            </View>
          )}
          <View style={styles.cardText}>
            <ThemedText style={[styles.name, { color: colors.text }]} numberOfLines={1}>
              {card.name}
            </ThemedText>
            {card.username ? (
              <ThemedText style={[styles.handle, { color: colors.textSecondary }]} numberOfLines={1}>
                @{card.username}
              </ThemedText>
            ) : null}
            <View style={styles.badges}>
              <CivicBadge
                tone={getTrustTierMeta(card.trustTier).tone}
                icon={TIER_ICON[card.trustTier]}
                label={trustTierLabel(locale, card.trustTier)}
              />
              {!verified && (
                <CivicBadge tone="caution" icon="shield-alert-outline" label={t('civic.attest.review.unverified')} />
              )}
            </View>
          </View>
        </View>

        <ThemedText style={[styles.caution, { color: colors.textSecondary }]}>
          {t('civic.attest.review.caution')}
        </ThemedText>

      </View>
    );
  };

  let actions: DialogAction[] | undefined;
  if (status === 'done' && result) {
    actions = [{ label: t('common.done') }];
  } else if (status === 'error' || subjectFailed) {
    actions = [{ label: t('common.close'), color: 'cancel' }];
  } else if (status === 'reviewing' && card) {
    actions = [
      {
        label: t(
          confirming
            ? 'civic.attest.review.submitting'
            : 'civic.attest.review.confirm',
        ),
        onPress: onConfirm,
        shouldCloseOnPress: false,
        disabled: confirming,
      },
      {
        label: t('common.cancel'),
        color: 'cancel',
        disabled: confirming,
      },
    ];
  }

  return (
    <Dialog
      control={control}
      onClose={onClose}
      placement="bottom"
      label={t('civic.attest.review.title')}
      actions={actions}
    >
      {body()}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  stateBlock: {
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  stateTitle: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  stateBody: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  reviewBlock: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 18,
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderWidth: 1,
    borderRadius: 18,
    borderCurve: 'continuous',
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  cardText: {
    flex: 1,
    gap: 4,
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
  },
  handle: {
    fontSize: 14,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
  },
  caution: {
    fontSize: 13,
    lineHeight: 19,
  },
});
