import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useOxy, useUpdateProfile } from '@oxy.so/services';
import { useColors } from '@/hooks/useColors';
import { UsernameStep } from '@/components/auth/UsernameStep';
import { useNetworkStatus } from '@/hooks/auth/useNetworkStatus';
import { generateSuggestedUsername } from '@/utils/auth/usernameUtils';
import { useAuthFlowContext } from '@/contexts/auth-flow-context';
import { checkIfOffline } from '@/utils/auth/networkUtils';
import { extractAuthErrorMessage, isNetworkOrTimeoutError } from '@/utils/auth/errorUtils';

/**
 * Import Identity - Username Screen
 *
 * Allows user to choose a username (skippable only when offline).
 * Mirrors create-identity/username: persists via useUpdateProfile so the
 * onboarding guard never sees a stale username-less cache.
 */
export default function ImportIdentityUsernameScreen() {
  const router = useRouter();
  const colors = useColors();
  const { oxyServices, user } = useOxy();
  const { isOffline } = useNetworkStatus();
  const { usernameRef, error: authFlowError, setAuthError } = useAuthFlowContext();
  const updateProfile = useUpdateProfile();

  const backgroundColor = colors.background;
  const textColor = colors.text;

  const [username, setUsername] = useState<string>(
    () => user?.username || usernameRef.current || generateSuggestedUsername(),
  );
  const [updateError, setUpdateError] = useState<string | null>(() => authFlowError);

  useEffect(() => {
    if (authFlowError) {
      setUpdateError(authFlowError);
      setAuthError(null);
    }
  }, [authFlowError, setAuthError]);

  useEffect(() => {
    usernameRef.current = username;
  }, [username, usernameRef]);

  const isUpdatingProfile = updateProfile.isPending;

  const handleContinue = useCallback(async () => {
    if (!oxyServices || !username.trim()) {
      return;
    }

    setUpdateError(null);

    if (!oxyServices.getAccessToken()) {
      const offline = await checkIfOffline();
      setUpdateError(
        offline
          ? 'You are offline. Reconnect and tap continue to save your username.'
          : 'Finishing setting up your account — tap continue again in a moment.',
      );
      return;
    }

    try {
      await updateProfile.mutateAsync({ username: username.trim() });
      usernameRef.current = username.trim();
      router.replace('/(auth)/import-identity/notifications');
    } catch (err: unknown) {
      const errorMessage = extractAuthErrorMessage(err, 'Failed to update username. Please try again.');
      const offline = await checkIfOffline();
      const isNetwork = isNetworkOrTimeoutError(err);
      usernameRef.current = username.trim();

      if (offline && isNetwork) {
        setUpdateError(
          'You are offline. Reconnect and tap continue to save your username.',
        );
      } else {
        setUpdateError(errorMessage);
      }
    }
  }, [username, oxyServices, router, usernameRef, updateProfile]);

  const handleSkip = useCallback(() => {
    usernameRef.current = '';
    router.replace('/(auth)/import-identity/notifications');
  }, [usernameRef, router]);

  return (
    <UsernameStep
      username={username}
      onUsernameChange={setUsername}
      onContinue={handleContinue}
      onSkip={isOffline ? handleSkip : undefined}
      isOffline={isOffline}
      oxyServices={oxyServices}
      backgroundColor={backgroundColor}
      textColor={textColor}
      isUpdating={isUpdatingProfile}
      updateError={updateError}
    />
  );
}
