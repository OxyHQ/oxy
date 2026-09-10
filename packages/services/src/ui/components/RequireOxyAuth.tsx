/**
 * RequireOxyAuth — the optional signed-out gate primitive (React Native).
 *
 * ONE shared way for any Oxy app to opt into a signed-out gate. It is entirely
 * OPTIONAL: a public app renders its children untouched (`prompt="off"`); an
 * auth-required app blocks them behind a signed-out state (`prompt="hard"`); an
 * app that mostly works signed-out but wants a nudge shows a dismissible banner
 * (`prompt="soft"`). Every mode reuses the ONE account dialog the provider
 * already mounts — opening the sign-in surface is always
 * `useOxy().openAccountDialog('signin')`; there is NO second dialog.
 *
 * Readiness gating (CRITICAL): the gate keys on the SDK's own readiness state
 * (`useOxy().canUsePrivateApi` / `isPrivateApiPending`), NEVER on app-local
 * hooks. While auth is still resolving (`isPrivateApiPending`) it renders a
 * neutral loading state so the signed-out wall never flashes before the
 * device-first cold boot concludes (the documented cold-boot race).
 *
 * Styling follows the sibling `OxyAccountDialogScreen`/`OxySignInButton` pattern —
 * `useTheme()` + `StyleSheet` (NOT NativeWind), so the gate renders correctly in
 * EVERY consumer, including apps that do not run NativeWind (e.g. the accounts
 * app).
 */

import type React from 'react';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '../context/OxyContext';
import { OxySignInButton } from './OxySignInButton';
import { LogoIcon } from './logo/LogoIcon';

/**
 * How `RequireOxyAuth` treats a signed-out (or still-resolving) session.
 *  - `off`  — always render children (public app; a no-op provided for symmetry).
 *  - `soft` — render children, plus a dismissible sign-in banner when signed out.
 *  - `hard` — block children behind a centered signed-out state until signed in.
 */
export type RequireOxyAuthPrompt = 'off' | 'soft' | 'hard';

export interface RequireOxyAuthProps {
  children: ReactNode;
  /** Gate behavior. @default 'hard' */
  prompt?: RequireOxyAuthPrompt;
  /** Replaces the neutral loading UI shown while auth is still resolving. */
  loadingFallback?: ReactNode;
  /** Replaces the entire default signed-out wall (`prompt="hard"`). */
  signedOutFallback?: ReactNode;
  /** Title for the default `prompt="hard"` wall. */
  title?: string;
  /** Subtitle for the default `prompt="hard"` wall. */
  subtitle?: string;
  /** Message for the `prompt="soft"` banner. */
  bannerMessage?: string;
  /** CTA label for the `prompt="soft"` banner. */
  bannerActionLabel?: string;
}

const DEFAULT_TITLE = 'Sign in to continue';
const DEFAULT_SUBTITLE = 'Sign in with your Oxy account to continue.';
const DEFAULT_BANNER_MESSAGE = "You're browsing signed out.";
const DEFAULT_BANNER_ACTION = 'Sign in';

/**
 * Optional signed-out gate. Wrap any subtree (or the whole app via the
 * provider's `requireAuth` prop) to opt into a shared, readiness-safe wall.
 */
export const RequireOxyAuth: React.FC<RequireOxyAuthProps> = ({
  children,
  prompt = 'hard',
  loadingFallback,
  signedOutFallback,
  title,
  subtitle,
  bannerMessage,
  bannerActionLabel,
}) => {
  const { canUsePrivateApi, isPrivateApiPending, openAccountDialog } = useOxy();

  // Public app: render straight through. Cheap enough to short-circuit before
  // touching any gate UI.
  if (prompt === 'off') {
    return <>{children}</>;
  }

  // Signed in (and token ready): render the protected subtree in every mode.
  if (canUsePrivateApi) {
    return <>{children}</>;
  }

  if (prompt === 'soft') {
    return (
      <SoftGate
        pending={isPrivateApiPending}
        message={bannerMessage ?? DEFAULT_BANNER_MESSAGE}
        actionLabel={bannerActionLabel ?? DEFAULT_BANNER_ACTION}
        onSignIn={() => openAccountDialog('signin')}
      >
        {children}
      </SoftGate>
    );
  }

  // prompt === 'hard'
  if (isPrivateApiPending) {
    return loadingFallback ? <>{loadingFallback}</> : <NeutralLoading />;
  }
  if (signedOutFallback) {
    return <>{signedOutFallback}</>;
  }
  return <HardWall title={title ?? DEFAULT_TITLE} subtitle={subtitle ?? DEFAULT_SUBTITLE} />;
};

// ---------------------------------------------------------------------------
// Soft gate — children + a dismissible sign-in banner while signed out.
// ---------------------------------------------------------------------------

interface SoftGateProps {
  children: ReactNode;
  pending: boolean;
  message: string;
  actionLabel: string;
  onSignIn: () => void;
}

const SoftGate: React.FC<SoftGateProps> = ({ children, pending, message, actionLabel, onSignIn }) => {
  const theme = useTheme();
  const [dismissed, setDismissed] = useState(false);

  // Never surface the nudge while auth is still resolving — only once the boot
  // has concluded signed out and the user has not dismissed it.
  const showBanner = !pending && !dismissed;

  return (
    <View style={styles.softRoot}>
      {showBanner ? (
        <View style={[styles.banner, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <LogoIcon height={20} color={theme.colors.primary} />
          <Text style={[styles.bannerText, { color: theme.colors.text }]} numberOfLines={2}>
            {message}
          </Text>
          <Pressable
            onPress={onSignIn}
            style={[styles.bannerCta, { backgroundColor: theme.colors.primary }]}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
          >
            <Text style={styles.bannerCtaText}>{actionLabel}</Text>
          </Pressable>
          <Pressable
            onPress={() => setDismissed(true)}
            style={styles.bannerDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={8}
          >
            <Text style={[styles.bannerDismissText, { color: theme.colors.textSecondary }]}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.softBody}>{children}</View>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Hard wall — centered signed-out state with the "Sign in with Oxy" CTA.
// ---------------------------------------------------------------------------

const HardWall: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const theme = useTheme();
  return (
    <View style={[styles.wallRoot, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.logoBadge, { backgroundColor: theme.colors.primarySubtle }]}>
        <LogoIcon height={44} color={theme.colors.primary} />
      </View>
      <Text style={[styles.wallTitle, { color: theme.colors.text }]}>{title}</Text>
      <Text style={[styles.wallSubtitle, { color: theme.colors.textSecondary }]}>{subtitle}</Text>
      <OxySignInButton variant="contained" style={styles.wallCta} />
    </View>
  );
};

const NeutralLoading: React.FC = () => {
  const theme = useTheme();
  return (
    <View style={[styles.wallRoot, { backgroundColor: theme.colors.background }]}>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
};

const styles = StyleSheet.create({
  softRoot: {
    flex: 1,
  },
  softBody: {
    flex: 1,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bannerText: {
    flex: 1,
    fontSize: 13.5,
  },
  bannerCta: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  bannerCtaText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  bannerDismiss: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerDismissText: {
    fontSize: 15,
    fontWeight: '600',
  },
  wallRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  logoBadge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  wallTitle: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  wallSubtitle: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    maxWidth: 340,
  },
  wallCta: {
    marginTop: 8,
    width: '100%',
    maxWidth: 320,
  },
});

export default RequireOxyAuth;
