import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import { Icons } from '@/constants/icons';
import { useTranslation } from '@/lib/i18n';

interface NotificationsStepProps {
  error: string | null;
  onRequestNotifications: () => void;
  /** Finish onboarding without asking for the permission. */
  onSkip: () => void;
  isRequestingNotifications: boolean;
  isSigningIn: boolean;
  backgroundColor: string;
  textColor: string;
}

/**
 * The last onboarding step: ask for the notification permission, which is what
 * lets "Sign in with Oxy" on another device reach this phone as a push. Asking
 * is optional; "Not now" finishes onboarding without the system prompt, and a
 * sign-in can always be approved by scanning its QR code instead.
 */
export function NotificationsStep({
  error,
  onRequestNotifications,
  onSkip,
  isRequestingNotifications,
  isSigningIn,
  backgroundColor,
  textColor,
}: NotificationsStepProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const busy = isRequestingNotifications || isSigningIn;

  const containerStyle = useMemo(
    () => [styles.container, { backgroundColor, paddingTop: insets.top }],
    [backgroundColor, insets.top],
  );
  const titleStyle = useMemo(() => [styles.title, { color: textColor }], [textColor]);
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: textColor, opacity: 0.6 }],
    [textColor],
  );

  return (
    <View style={containerStyle}>
      <View className="flex-1 p-space-24 pt-space-60 justify-center">
        <View className="items-center mb-space-32">
          <Icons.notification size="3xl" fill={textColor} />
        </View>

        <Text style={titleStyle} accessibilityRole="header">
          {t('auth.notificationsStep.title')}
        </Text>
        <Text style={subtitleStyle}>{t('auth.notificationsStep.subtitle')}</Text>

        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        <Button
          appearance="solid"
          tone="accent"
          onPress={onRequestNotifications}
          disabled={busy}
          loading={busy}
          className="mt-space-32"
        >
          {t('auth.notificationsStep.enable')}
        </Button>
        <Button appearance="subtle" onPress={onSkip} disabled={busy} className="mt-space-8">
          {t('auth.notificationsStep.notNow')}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    fontSize: 38,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 32,
    lineHeight: 22,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
});
