/**
 * The sign-in entry's embedded QR, over the split card's photo carousel: scan
 * it with Commons on a phone and this screen is signed in.
 *
 * It owns one QR-only request (`controller.startInlineQr()`): started the
 * first time the block is actually laid out on screen — never while its column
 * is hidden below `md` — renewed when it expires, and withdrawn when the block
 * goes away while it is still approvable. It never pushes to a phone or opens Commons —
 * the person did not ask for either by opening the screen. Any other sign-in
 * they choose supersedes it like any new attempt.
 *
 * Anti-phishing: the plate encodes `signIn.qrPayload` and renders nothing
 * derived from it; the approver resolves the app server-side.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '@oxy.so/bloom/button';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import type { AccountDialogController } from '@oxy.so/core';
import { useI18n } from '../../hooks/useI18n';
import { useAccountDialogSnapshot } from '../../hooks/accountDialogSnapshot';

/** High-contrast, un-themed on purpose: scan reliability. */
const QR_PLATE_BG = '#FFFFFF';
const QR_FOREGROUND = '#000000';
const QR_SIZE = 112;
const PLATE_PADDING = 8;
const PLATE_SIZE = QR_SIZE + PLATE_PADDING * 2;

export const InlineCommonsQr: React.FC<{ controller: AccountDialogController | null }> = ({ controller }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { signIn } = useAccountDialogSnapshot(controller);
  const live = signIn.inline && (signIn.phase === 'starting' || signIn.phase === 'waiting');
  const expired = signIn.inline && signIn.phase === 'error' && signIn.failure === 'expired';

  // Laid out with a size only where its column shows (`display: none` below
  // `md` lays out empty), so that is when a request is worth having.
  const [shown, setShown] = useState(false);

  // One request for as long as the block is on screen. Withdrawn on the way
  // out only while it is still ours and still approvable: an attempt the
  // person started meanwhile (a passkey window, "Continue with Oxy") is theirs.
  useEffect(() => {
    if (!controller || !shown) return;
    const { signIn: current } = controller.getSnapshot();
    if (!(current.inline && (current.phase === 'starting' || current.phase === 'waiting'))) {
      void controller.startInlineQr();
    }
    return () => {
      const { signIn: last } = controller.getSnapshot();
      if (last.inline && (last.phase === 'starting' || last.phase === 'waiting')) controller.cancelSignIn();
    };
  }, [controller, shown]);

  // A code only lives a few minutes; an expired one is replaced, not reported.
  useEffect(() => {
    if (controller && expired) void controller.startInlineQr();
  }, [controller, expired]);

  let plate: React.ReactNode;
  if (signIn.inline && signIn.progress === 'identity-confirmed') {
    plate = <RiCheckboxCircleLine size="3xl" fill={theme.colors.success} />;
  } else if (live && signIn.qrPayload && signIn.progress !== 'confirming-identity') {
    plate = <QRCode value={signIn.qrPayload} size={QR_SIZE} backgroundColor={QR_PLATE_BG} color={QR_FOREGROUND} />;
  } else if (live || expired || (signIn.inline && signIn.phase === 'completed')) {
    plate = <ActivityIndicator size="large" color={QR_FOREGROUND} />;
  } else {
    // Failed for a reason renewing will not fix by itself, or superseded and
    // then withdrawn: one press for a new code.
    plate = (
      <Button
        appearance="plain"
        tone="neutral"
        size="sm"
        iconOnly
        leadingIcon={RiRefreshLine}
        accessibilityLabel={t('signin.qr.renew')}
        onPress={() => void controller?.startInlineQr()}
        testID="inline-qr-renew"
      />
    );
  }

  return (
    <View
      style={styles.block}
      testID="inline-commons-qr"
      onLayout={(event) => {
        if (event.nativeEvent.layout.width > 0) setShown(true);
      }}
    >
      <View style={[styles.plate, { borderColor: theme.colors.border }]}>{plate}</View>
      <Text style={[styles.caption, styles.captionOnMedia]}>
        {t('signin.qr.caption')}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  block: {
    width: PLATE_SIZE,
    alignItems: 'center',
    gap: 6,
  },
  plate: {
    width: PLATE_SIZE,
    height: PLATE_SIZE,
    padding: PLATE_PADDING,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: QR_PLATE_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  captionOnMedia: {
    color: '#FFFFFF',
    fontWeight: '500',
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
});
