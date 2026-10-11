import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { UsernameStep } from '@/components/auth/UsernameStep';
import { useNetworkStatus } from '@/hooks/auth/useNetworkStatus';
import { useUsernameStep } from '@/hooks/auth/useUsernameStep';

/**
 * Create Identity - Username Screen
 *
 * The step that creates the account: the key made at the start of the wizard
 * is registered here, together with the username (`useUsernameStep`). The
 * username is mandatory; offline, the choice is kept and the account is created
 * with it on reconnect.
 */
export default function CreateIdentityUsernameScreen() {
  const router = useRouter();
  const colors = useColors();
  const { isOffline } = useNetworkStatus();
  const onDone = useCallback(() => {
    router.push('/(auth)/create-identity/notifications');
  }, [router]);
  const { username, setUsername, handleContinue, oxyServices, isUpdating, updateError } =
    useUsernameStep({ onDone });

  return (
    <UsernameStep
      username={username}
      onUsernameChange={setUsername}
      onContinue={handleContinue}
      onSkip={undefined}
      isOffline={isOffline}
      oxyServices={oxyServices}
      backgroundColor={colors.background}
      textColor={colors.text}
      isUpdating={isUpdating}
      updateError={updateError}
    />
  );
}
