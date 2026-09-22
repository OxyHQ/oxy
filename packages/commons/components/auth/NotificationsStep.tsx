import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';

interface NotificationsStepProps {
  error: string | null;
  onRequestNotifications: () => void;
  isRequestingNotifications: boolean;
  isSigningIn: boolean;
  backgroundColor: string;
  textColor: string;
}

/**
 * Notifications step component for requesting push notification permissions
 */
export function NotificationsStep({
  error,
  onRequestNotifications,
  isRequestingNotifications,
  isSigningIn,
  backgroundColor,
  textColor,
}: NotificationsStepProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const containerStyle = useMemo(
    () => [styles.container, { backgroundColor, paddingTop: insets.top }],
    [backgroundColor, insets.top]
  );
  const titleStyle = useMemo(
    () => [styles.title, { color: textColor }],
    [textColor]
  );
  const subtitleStyle = useMemo(
    () => [styles.subtitle, { color: textColor, opacity: 0.6 }],
    [textColor]
  );

  return (
    <View style={containerStyle}>
      <View style={styles.stepContainer}>
        <View style={styles.notificationIllustration}>
          <Text style={styles.notificationIcon}>🔔</Text>
        </View>

        <Text style={titleStyle}>Receive push notifications</Text>
        <Text style={subtitleStyle}>
          Don&apos;t miss messages from friends, transaction alerts, and feature updates.
        </Text>

        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        <Button appearance="solid" tone="accent" onPress={onRequestNotifications} disabled={isRequestingNotifications || isSigningIn} loading={isRequestingNotifications || isSigningIn} style={styles.primaryButton}>Enable notifications</Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  stepContainer: {
    flex: 1,
    padding: 24,
    paddingTop: 60,
    justifyContent: 'center',
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
  primaryButton: {
    marginTop: 32,
  },
  notificationIllustration: {
    alignItems: 'center',
    marginBottom: 32,
  },
  notificationIcon: {
    fontSize: 64,
  },
});

