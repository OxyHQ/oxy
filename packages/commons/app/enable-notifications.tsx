import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useOxy } from '@oxy.so/services';
import { useColors } from '@/hooks/useColors';
import { NotificationsStep } from '@/components/auth/NotificationsStep';
import { useAuthHandlers } from '@/hooks/auth/useAuthHandlers';

/**
 * The last onboarding step, for both wizards (create and import): ask for the
 * notification permission, then open the vault.
 *
 * A ROOT route, outside both `Stack.Protected` groups, on purpose. The username
 * step registers or signs in, and the moment the session has a username the
 * onboarding status is `complete`: the `(auth)` guard turns off in the same
 * render. This step used to live inside `(auth)`, so the navigation to it was
 * dropped and every online onboarding skipped it — Commons never asked for the
 * permission, and push sign-in requests could not reach the phone. Here it stays
 * reachable on both sides of that flip. An offline import that skipped the
 * username step arrives here without a session; the handlers sign in first.
 */
export default function EnableNotificationsScreen() {
  const colors = useColors();
  const { signIn, oxyServices, isAuthenticated } = useOxy();
  const [error, setAuthError] = useState<string | null>(null);
  const [isSigningIn, setSigningIn] = useState(false);

  const { handleRequestNotifications, handleSkipNotifications, isRequestingNotifications } =
    useAuthHandlers({ signIn, oxyServices, setAuthError, setSigningIn, isAuthenticated });

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
      pointerEvents={isSigningIn ? 'none' : 'auto'}
    >
      <NotificationsStep
        error={error}
        onRequestNotifications={handleRequestNotifications}
        onSkip={handleSkipNotifications}
        isRequestingNotifications={isRequestingNotifications}
        isSigningIn={isSigningIn}
        backgroundColor={colors.background}
        textColor={colors.text}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
