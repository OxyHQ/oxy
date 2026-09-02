import React, { useEffect, useId, useMemo, useState } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import QRCode from 'react-native-qrcode-svg';
import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { CivicBadge } from '@/components/civic/CivicBadge';
import { useAttestQr } from '@/hooks/useAttestQr';
import { useTranslation } from '@/lib/i18n';

/** Tick the countdown once a second. */
const TICK_MS = 1000;

interface AttestQrSheetProps {
  /** Fired once the sheet has finished its close animation (parent unmounts it). */
  onClose: () => void;
}

/**
 * A's "Get confirmed in person" bottom sheet.
 *
 * Replaces the old full-screen `attest-me`: shows the person being attested (A)
 * a FRESHLY-minted attestation QR (single-use nonce + 10-min expiry) for a
 * counterparty (B) to scan. The freshness is the anti-replay guarantee — a
 * static QR could be re-scanned by bots to spam attestations, so each open mints
 * a new nonce and the countdown / Regenerate keep it live. Rendered as a Bloom
 * bottom sheet (imperative control, opened from the mount effect) so it rises
 * over the ID tab instead of pushing a route.
 */
export function AttestQrSheet({ onClose }: AttestQrSheetProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const control = useDialogControl();

  // One opaque interaction id per sheet session (stable across regenerations).
  const context = `irl-${useId()}`;
  const { state, payload, exp, regenerate } = useAttestQr(context);

  // Imperative controls bind during the commit's layout phase, so opening from
  // a mount effect is the sanctioned pattern (mirrors app/approve.tsx).
  useEffect(() => {
    control.open();
  }, [control]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const remainingMs = exp ? exp - now : 0;
  const expired = exp !== null && remainingMs <= 0;
  const mmss = useMemo(() => {
    const total = Math.max(0, Math.floor(remainingMs / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }, [remainingMs]);

  return (
    <Dialog
      control={control}
      onClose={onClose}
      placement="bottom"
      label={t('civic.attest.request.title')}
      actions={
        expired || state === 'error'
          ? [
              {
                label: t('civic.attest.request.regenerate'),
                onPress: regenerate,
                shouldCloseOnPress: false,
              },
            ]
          : undefined
      }
    >
      <View style={styles.body}>
        <ThemedText style={[styles.title, { color: colors.text }]}>
          {t('civic.attest.request.title')}
        </ThemedText>
        <ThemedText style={[styles.subtitle, { color: colors.textSecondary }]}>
          {t('civic.attest.request.subtitle')}
        </ThemedText>

        <View style={[styles.qrSurface, { backgroundColor: colors.card }]}>
          {state === 'loading' && <ActivityIndicator size="large" color={colors.tint} />}

          {state === 'error' && (
            <View style={styles.qrState}>
              <MaterialCommunityIcons name="alert-circle-outline" size={40} color={colors.error} />
              <ThemedText style={[styles.qrStateText, { color: colors.text }]}>
                {t('civic.attest.request.buildError')}
              </ThemedText>
            </View>
          )}

          {state === 'ready' && payload && !expired && (
            <View style={styles.qrWrapper}>
              <QRCode value={payload} size={216} color="#1C1C1E" backgroundColor="transparent" />
            </View>
          )}

          {state === 'ready' && expired && (
            <View style={styles.qrState}>
              <MaterialCommunityIcons name="timer-off-outline" size={40} color={colors.textSecondary} />
              <ThemedText style={[styles.qrStateText, { color: colors.textSecondary }]}>
                {t('civic.attest.request.expired')}
              </ThemedText>
            </View>
          )}
        </View>

        {state === 'ready' && !expired && (
          <CivicBadge tone="caution" icon="timer-outline" label={t('civic.attest.request.expiresIn', { time: mmss })} />
        )}

        <ThemedText style={[styles.hint, { color: colors.textSecondary }]}>
          {t('civic.attest.request.hint')}
        </ThemedText>

      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  body: {
    alignItems: 'center',
    gap: 18,
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 21,
  },
  qrSurface: {
    width: 264,
    height: 264,
    borderRadius: 28,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrWrapper: {
    padding: 12,
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  qrState: {
    alignItems: 'center',
    gap: 10,
    padding: 16,
  },
  qrStateText: {
    fontSize: 14,
    textAlign: 'center',
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: 8,
  },
});
