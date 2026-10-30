/**
 * Sign-in for a device with no keyboard — a TV, a photo frame, a kiosk: a large
 * QR that any phone camera opens, and the code to compare on the phone.
 *
 * The QR encodes the request's https approval page
 * (`signIn.approvalUrl`, `auth.oxy.so/device?user_code=…`), not the
 * `oxycommons://` deep link the account dialog shows: whoever scans a frame may
 * not have Commons, and the page works in any phone browser. It prints the same
 * code this surface shows, so the person can check they are approving THIS
 * screen before they press Allow there.
 *
 * It owns one QR-only request (`controller.startInlineQr()`), exactly like the
 * sign-in entry's embedded QR (`signIn/InlineCommonsQr.tsx`): started on mount,
 * renewed when it expires, withdrawn on unmount while it is still approvable.
 * It never pushes to a phone or opens Commons. On approval the controller
 * claims the session and `OxyProvider` signs the app in, so the host simply
 * stops rendering this.
 *
 * Anti-phishing: the plate encodes `signIn.approvalUrl` and the code line shows
 * `signIn.authorizeCode`, both PUBLIC; nothing about the application is read out
 * of either here. The secret `sessionToken` never leaves the controller.
 */

import type React from 'react';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '@oxy.so/bloom/button';
import { Code } from '@oxy.so/bloom/code';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../context/oxyRuntimeContext';
import { useI18n } from '../hooks/useI18n';
import { useAccountDialogSnapshot } from '../hooks/accountDialogSnapshot';

/** High-contrast, un-themed on purpose: scan reliability. */
const QR_PLATE_BG = '#FFFFFF';
const QR_FOREGROUND = '#000000';
/** Big enough to scan from across a room at the default size. */
const DEFAULT_QR_SIZE = 280;
/** The quiet zone around the symbol, as a fraction of its size. */
const PLATE_PADDING_RATIO = 0.06;

export interface OxyDeviceSignInProps {
  /** Edge of the QR symbol in points. Defaults to 280. */
  size?: number;
}

export const OxyDeviceSignIn: React.FC<OxyDeviceSignInProps> = ({ size = DEFAULT_QR_SIZE }) => {
  const theme = useTheme();
  const { t } = useI18n();
  const { accountDialogController: controller } = useOxy();
  const { signIn } = useAccountDialogSnapshot(controller);
  const live = signIn.inline && (signIn.phase === 'starting' || signIn.phase === 'waiting');
  const expired = signIn.inline && signIn.phase === 'error' && signIn.failure === 'expired';

  // One request for as long as this is on screen. Withdrawn on the way out only
  // while it is still ours and still approvable.
  useEffect(() => {
    if (!controller) return;
    const { signIn: current } = controller.getSnapshot();
    if (!(current.inline && (current.phase === 'starting' || current.phase === 'waiting'))) {
      void controller.startInlineQr();
    }
    return () => {
      const { signIn: last } = controller.getSnapshot();
      if (last.inline && (last.phase === 'starting' || last.phase === 'waiting'))
        controller.cancelSignIn();
    };
  }, [controller]);

  // A code only lives a few minutes; an expired one is replaced, not reported.
  useEffect(() => {
    if (controller && expired) void controller.startInlineQr();
  }, [controller, expired]);

  const padding = Math.round(size * PLATE_PADDING_RATIO);
  const showsCode = live && signIn.approvalUrl && signIn.progress !== 'confirming-identity';

  let plate: React.ReactNode;
  if (signIn.inline && signIn.progress === 'identity-confirmed') {
    plate = <RiCheckboxCircleLine size="3xl" fill={theme.colors.success} />;
  } else if (showsCode && signIn.approvalUrl) {
    plate = (
      <QRCode
        value={signIn.approvalUrl}
        size={size}
        backgroundColor={QR_PLATE_BG}
        color={QR_FOREGROUND}
      />
    );
  } else if (live || expired || (signIn.inline && signIn.phase === 'completed')) {
    plate = <SpinnerIcon size={Math.round(size / 6)} color={QR_FOREGROUND} />;
  } else {
    // Failed for a reason renewing will not fix by itself, or superseded and
    // then withdrawn: one press for a new code.
    plate = (
      <Button
        appearance="plain"
        tone="neutral"
        leadingIcon={RiRefreshLine}
        onPress={() => void controller?.startInlineQr()}
        testID="device-sign-in-renew"
      >
        {t('signin.qr.renew')}
      </Button>
    );
  }

  return (
    <View style={styles.block} testID="oxy-device-sign-in">
      <Text style={[styles.title, { color: theme.colors.text }]}>{t('signin.device.title')}</Text>
      <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>
        {t('signin.device.caption')}
      </Text>
      <View
        style={[styles.plate, { width: size + padding * 2, height: size + padding * 2, padding }]}
      >
        {plate}
      </View>
      {showsCode && signIn.authorizeCode ? (
        <View style={styles.codeBlock}>
          <Text style={[styles.codeHint, { color: theme.colors.textSecondary }]}>
            {t('signin.device.codeHint')}
          </Text>
          <Code testID="device-sign-in-code" style={styles.code}>
            {signIn.authorizeCode}
          </Code>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  block: {
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '600',
    textAlign: 'center',
  },
  caption: {
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  plate: {
    borderRadius: 16,
    backgroundColor: QR_PLATE_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBlock: {
    alignItems: 'center',
    gap: 4,
  },
  codeHint: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  code: {
    fontSize: 14,
  },
});
