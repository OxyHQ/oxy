/**
 * The PRIMARY visual of an active "Sign in with Oxy" request — one surface per
 * route, chosen by {@link RequestPrimarySurface} from the controller's own facts.
 *
 * Each is a leading visual and nothing else: the status sentence underneath is
 * owned by `signInProgressLabel`, and the alternatives by `TroubleDisclosure`.
 * That separation is what keeps exactly one primary action on screen (issue
 * #691) — a surface here can never grow a competing button.
 *
 * Anti-phishing: the QR plate encodes `signIn.qrPayload` and renders NOTHING
 * derived from it. Application identity, origin, and scopes are resolved
 * server-side by the approver (Commons), never read out of the payload here.
 */

import type React from 'react';
import { ActivityIndicator, View } from 'react-native';
import MaterialCommunityIcons from '../../icons/MaterialCommunityIcons';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '@oxyhq/bloom/button';
import { useTheme } from '@oxyhq/bloom/theme';
import { Text } from '@oxyhq/bloom/typography';
import type { CommonsDeliveryRoute, SignInProgress } from '@oxyhq/core';
import { authChooserStyles as styles } from './styles';
import type { Theme, Translate } from './types';

/** High-contrast QR colors — intentionally fixed (NOT themed) for scan reliability. */
const QR_PLATE_BG = '#FFFFFF';
const QR_FOREGROUND = '#000000';
const QR_SIZE = 196;
/** The leading route glyph, sized to sit where the QR plate otherwise would. */
const ROUTE_GLYPH_SIZE = 44;

/**
 * The indeterminate leading visual: the request exists but has nothing to show yet.
 * Uses RN's ActivityIndicator — `@oxyhq/bloom/loading` can tree-shake to `undefined`
 * in rolldown-vite production bundles when co-imported with `@oxyhq/bloom/button`
 * (auth.oxy.so/authorize blank screen, React #130).
 */
export const PreparingSurface: React.FC = () => {
  const theme = useTheme();
  return <ActivityIndicator size="large" color={theme.colors.primary} />;
};

/** The leading glyph for a route whose surface is elsewhere (the phone, Commons). */
export const RouteGlyph: React.FC<{
  name: keyof typeof MaterialCommunityIcons.glyphMap;
  color: string;
}> = ({ name, color }) => (
  <MaterialCommunityIcons name={name} size={ROUTE_GLYPH_SIZE} color={color} />
);

/** The cross-device handoff: a headline over the fixed-contrast QR plate. */
export const QrPlate: React.FC<{ payload: string; theme: Theme; t: Translate }> = ({
  payload,
  theme,
  t,
}) => (
  <>
    <Text style={[styles.qrHeadline, { color: theme.colors.text }]}>
      {t('accountSwitcher.qrHeadline')}
    </Text>
    <View style={styles.qrPlate}>
      <QRCode value={payload} size={QR_SIZE} backgroundColor={QR_PLATE_BG} color={QR_FOREGROUND} />
    </View>
  </>
);

/**
 * The acquisition surface. For someone with no Commons at all this is the
 * GENUINE primary route, not a fallback — a same-device QR they would have to
 * scan with the very screen showing it is a dead end — so it renders as the
 * surface's one primary action.
 */
export const GetCommonsPrompt: React.FC<{
  theme: Theme;
  t: Translate;
  onGetCommons: () => void;
}> = ({ theme, t, onGetCommons }) => (
  <>
    <Text style={[styles.mutedText, { color: theme.colors.textSecondary }]}>
      {t('accountSwitcher.commonsNotInstalled')}
    </Text>
    <Button
      variant="primary"
      onPress={onGetCommons}
      style={styles.primaryButton}
      testID="get-commons-button"
    >
      {t('accountSwitcher.getCommons')}
    </Button>
  </>
);

/**
 * The one primary visual for the request's current state.
 *
 * Ordered most-terminal-first, so a late-arriving route can never pull the
 * surface back from "confirming" to a QR the user has already scanned. Every
 * branch reads only the facts it is handed — there is no local timeline, and no
 * dependency on WHICH kind of request produced them (the account dialog's device
 * flow and the IdP's OAuth-bound lane both resolve the same three).
 */
export const RequestPrimarySurface: React.FC<{
  route: CommonsDeliveryRoute | null;
  progress: SignInProgress;
  qrPayload: string | null;
  theme: Theme;
  t: Translate;
}> = ({ route, progress, qrPayload, theme, t }) => {
  if (progress === 'identity-confirmed') {
    return <RouteGlyph name="check-circle" color={theme.colors.success} />;
  }
  if (progress === 'confirming-identity') {
    return <PreparingSurface />;
  }
  if (route === 'qr' && qrPayload) {
    return <QrPlate payload={qrPayload} theme={theme} t={t} />;
  }
  if (route === 'await-push') {
    return <RouteGlyph name="cellphone-message" color={theme.colors.primary} />;
  }
  if (route === 'open-commons') {
    return <RouteGlyph name="open-in-app" color={theme.colors.primary} />;
  }
  // No route resolved yet (or a route with no payload to render): the request is
  // being prepared. Honest, and the only state that is not route-specific.
  return <PreparingSurface />;
};
