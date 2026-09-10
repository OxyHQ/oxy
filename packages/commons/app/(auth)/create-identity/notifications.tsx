import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useOxy } from '@oxy.so/services';
import { useColors } from '@/hooks/useColors';
import { NotificationsStep } from '@/components/auth/NotificationsStep';
import { useAuthHandlers } from '@/hooks/auth/useAuthHandlers';
import { useAuthFlowContext } from '@/contexts/auth-flow-context';

/**
 * Create Identity - Notifications Screen
 *
 * Requests push notification permissions and completes onboarding.
 * Uses the shared auth handlers so offline/resume paths can sign in first.
 */
export default function CreateIdentityNotificationsScreen() {
  const colors = useColors();
  const { signIn, oxyServices, isAuthenticated } = useOxy();
  const { error, isSigningIn, setAuthError, setSigningIn, usernameRef } = useAuthFlowContext();

  const backgroundColor = colors.background;
  const textColor = colors.text;

  const { handleRequestNotifications, isRequestingNotifications } = useAuthHandlers({
    signIn,
    oxyServices,
    usernameRef,
    setAuthError,
    setSigningIn,
    isAuthenticated,
  });

  return (
    <View style={[styles.container, { backgroundColor }]} pointerEvents={isSigningIn ? 'none' : 'auto'}>
      <NotificationsStep
        error={error}
        onRequestNotifications={handleRequestNotifications}
        isRequestingNotifications={isRequestingNotifications}
        isSigningIn={isSigningIn}
        backgroundColor={backgroundColor}
        textColor={textColor}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
