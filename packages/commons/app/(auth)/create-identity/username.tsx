import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { UsernameStep } from '@/components/auth/UsernameStep';
import { useNetworkStatus } from '@oxy.so/bloom/connection-status';
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
  const { online } = useNetworkStatus();
  const onDone = useCallback(() => {
    router.replace('/enable-notifications');
  }, [router]);
  const { username, setUsername, handleContinue, oxyServices, isUpdating, updateError } =
    useUsernameStep({ onDone });

  return (
    <UsernameStep
      username={username}
      onUsernameChange={setUsername}
      onContinue={handleContinue}
      onSkip={undefined}
      isOffline={!online}
      oxyServices={oxyServices}
      backgroundColor={colors.background}
      textColor={colors.text}
      isUpdating={isUpdating}
      updateError={updateError}
    />
  );
}
