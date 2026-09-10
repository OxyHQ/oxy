import { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Linking, ScrollView } from 'react-native';
import { useOxy, LogoText, openAccountDialog } from '@oxy.so/services';
import { logger } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui';
import { CREATE_ACCOUNT_HELP_URL } from '@/constants/auth';

/**
 * Sign-In Screen (the only `(auth)` route)
 *
 * Accounts owns no sign-in UI of its own. Authentication is an ecosystem
 * concern, so this screen is a thin branded shell — logo, welcome copy, and a
 * single "Sign in with Oxy" button — that hands off to the SDK's in-app
 * `OxyAccountDialog` (mounted globally by `OxyProvider`).
 * every auth path: the first-party password + optional-2FA flow as the
 * primary action, plus the cross-app device flow (same-device deep-link +
 * "sign in on another device" QR) as a secondary option. There is no
 * app-local password form, 2FA step, or IdP redirect here — the SDK is the
 * single sign-in authority, and it never navigates away from the app.
 *
 * Cross-domain restore is device-first, owned entirely by the SDK's
 * `OxyProvider` cold boot (`runSessionColdBoot`) — this screen never wires it.
 *
 * The root Stack (`app/_layout.tsx`) owns the `(auth)`↔`(tabs)` swap keyed on
 * session, so this screen never navigates across that boundary itself: it
 * renders a neutral backdrop while auth is still resolving or once the user is
 * authenticated, and lets the root perform the swap. This avoids the
 * render/redirect race that a child-screen cross-group navigation would cause.
 */
export default function SignInScreen() {
  const colors = useColors();
  const { t } = useTranslation();
  const { isAuthenticated, isAuthResolved } = useOxy();

  const handleSignInWithOxy = useCallback(() => {
    // Reveals the SDK's shared sign-in surface: "Continue with Oxy" IdP popup,
    // a same-device deep-link to the Oxy app, and a QR for another device. The
    // modal is mounted by OxyProvider; this just opens it.
    openAccountDialog('signin');
  }, []);

  const handleGetTheApp = useCallback(() => {
    Linking.openURL(CREATE_ACCOUNT_HELP_URL).catch((error) => {
      logger.error(
        'SignInScreen: failed to open get-the-app URL',
        error instanceof Error ? error : new Error(String(error)),
        { component: 'SignInScreen' },
      );
    });
  }, []);

  const containerStyle = useMemo(
    () => [styles.container, { backgroundColor: colors.background }],
    [colors.background],
  );

  // Neutral backdrop while the session is still resolving, or once the user is
  // authenticated (the root Stack will swap to `(tabs)`). Rendering the shell in
  // those windows would flash sign-in UI at a returning user.
  if (!isAuthResolved || isAuthenticated) {
    return <View style={containerStyle} />;
  }

  return (
    <ScrollView
      style={containerStyle}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.content}>
        <LogoText height={40} style={styles.logo} />

        <Text style={[styles.title, { color: colors.text }]}>
          {t('auth.signIn.title')}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {t('auth.signIn.subtitle')}
        </Text>

        <View style={styles.actions}>
          <Button
            variant="primary"
            onPress={handleSignInWithOxy}
            style={styles.primaryButton}
            testID="sign-in-with-oxy"
          >
            {t('auth.signIn.withOxy')}
          </Button>
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: colors.textSecondary }]}>
          {t('auth.signIn.noAccount')}
        </Text>
        <Button
          variant="ghost"
          onPress={handleGetTheApp}
          style={styles.footerButton}
          testID="sign-in-get-app"
        >
          {t('auth.signIn.getTheApp')}
        </Button>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'space-between',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingTop: 48,
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  logo: {
    alignSelf: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 32,
  },
  actions: {
    width: '100%',
    gap: 12,
  },
  primaryButton: {
    width: '100%',
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 48,
    paddingTop: 24,
    alignItems: 'center',
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  footerText: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  footerButton: {
    minWidth: 200,
  },
});
