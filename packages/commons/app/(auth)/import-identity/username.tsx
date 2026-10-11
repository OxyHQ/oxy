import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { UsernameStep } from '@/components/auth/UsernameStep';
import { useNetworkStatus } from '@/hooks/auth/useNetworkStatus';
import { useUsernameStep } from '@/hooks/auth/useUsernameStep';
import { persistPendingUsername } from '@/hooks/identity/identityStore';

/**
 * Import Identity - Username Screen
 *
 * Reached after an import whose key has no account (or could not be checked
 * because the device is offline). Continue creates the account with this
 * username — or, for a key that turns out to have one, just signs in
 * (`useUsernameStep`). Skippable only offline, for a key the user knows already
 * has an account: nothing is registered without a username.
 */
export default function ImportIdentityUsernameScreen() {
  const router = useRouter();
  const colors = useColors();
  const { isOffline } = useNetworkStatus();
  const onDone = useCallback(() => {
    router.replace('/(auth)/import-identity/notifications');
  }, [router]);
  const { username, setUsername, handleContinue, oxyServices, isUpdating, updateError } =
    useUsernameStep({ onDone });

  const handleSkip = useCallback(() => {
    void persistPendingUsername(null);
    router.replace('/(auth)/import-identity/notifications');
  }, [router]);

  return (
    <UsernameStep
      username={username}
      onUsernameChange={setUsername}
      onContinue={handleContinue}
      onSkip={isOffline ? handleSkip : undefined}
      isOffline={isOffline}
      oxyServices={oxyServices}
      backgroundColor={colors.background}
      textColor={colors.text}
      isUpdating={isUpdating}
      updateError={updateError}
    />
  );
}
