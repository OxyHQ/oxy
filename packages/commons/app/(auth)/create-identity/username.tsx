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
 * Create Identity - Username Screen
 *
 * Allows the user to choose a username (mandatory when online).
 *
 * IMPORTANT: We route the username update through the `useUpdateProfile`
 * mutation hook (NOT a direct `oxyServices.updateProfile` call). The
 * mutation performs an optimistic cache update that:
 *  1. Writes the new username into `queryKeys.accounts.current()` immediately.
 *  2. Mirrors it into `useAuthStore` via `onSuccess`.
 *  3. Invalidates related queries on success so other consumers refetch.
 *
 * Without the optimistic step a race exists where:
 *  - The server PUT resolves and we navigate to `/notifications`.
 *  - Concurrently, `useCurrentUser` refetches and (briefly) returns the
 *    cached pre-update user, which mirrors `username: undefined` into the
 *    auth store via `useCurrentUser`'s effect.
 *  - `useOnboardingStatus` then sees `hasUsername=false`, flips
 *    `needsAuth=true`, and the root guard kicks us back to `(auth)`.
 *  - `create-identity/index.tsx` redirects to `/username` and the screen
 *    remounts — the suggested username regenerates and looks "reset".
 *
 * The optimistic cache update closes that window: the cache has the new
 * username by the time we navigate, so the guard never flips.
 */
export default function CreateIdentityUsernameScreen() {
  const router = useRouter();
  const colors = useColors();
  const { oxyServices, user } = useOxy();
  const { isOffline } = useNetworkStatus();
  const { usernameRef, error: authFlowError, setAuthError } = useAuthFlowContext();
  const updateProfile = useUpdateProfile();

  const backgroundColor = colors.background;
  const textColor = colors.text;

  // Initialise once per mount. If the user already has a username (resuming
  // after a network failure or a remount), prefer it; otherwise generate a
  // suggestion. Using the lazy initialiser form keeps the value stable across
  // re-renders so navigation hiccups never visibly regenerate the suggestion.
  const [username, setUsername] = useState<string>(
    () => user?.username || usernameRef.current || generateSuggestedUsername(),
  );
  const [updateError, setUpdateError] = useState<string | null>(() => authFlowError);

  // Surface any sync error stashed by the create-identity resume path.
  useEffect(() => {
    if (authFlowError) {
      setUpdateError(authFlowError);
      setAuthError(null);
    }
  }, [authFlowError, setAuthError]);

  // Keep the ref in sync so other steps (e.g. import-identity recovery) can
  // observe what the user typed if they back-navigate.
  useEffect(() => {
    usernameRef.current = username;
  }, [username, usernameRef]);

  const isUpdatingProfile = updateProfile.isPending;

  const handleContinue = useCallback(async () => {
    if (!oxyServices || !username.trim()) {
      return;
    }

    setUpdateError(null);

    // The username write is an AUTHENTICATED call. If the create-sync hasn't
    // established a session yet — an offline create, or a signIn that hasn't
    // finished re-syncing after reconnect — `oxyServices` has no access token.
    // Firing updateProfile then throws "No active access token", and because
    // mutations run with networkMode:'offlineFirst' + retry, the retry is
    // PAUSED, leaving the Confirm button spinning forever with no way out
    // (issue #605). Guard it: surface a clear, actionable state instead. The
    // session self-establishes via the reconnect/sync handler, so tapping
    // Continue again once it's ready succeeds.
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
      // mutateAsync triggers the optimistic onMutate FIRST, which:
      //  - cancels in-flight queries on accounts.current()
      //  - writes the new username into the query cache (and via onSuccess
      //    into useAuthStore)
      // …so by the time the await resolves with the server response, the
      // root-layout onboarding guard has already observed `hasUsername=true`.
      await updateProfile.mutateAsync({ username: username.trim() });
      usernameRef.current = username.trim();

      router.push('/(auth)/create-identity/notifications');
    } catch (err: unknown) {
      const errorMessage = extractAuthErrorMessage(err, 'Failed to update username. Please try again.');

      // Critical: keep the user on this step until the username is actually
      // persisted server-side. Previously we would advance on transient
      // network errors, which left the account permanently username-less.
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

  return (
    <UsernameStep
      username={username}
      onUsernameChange={setUsername}
      onContinue={handleContinue}
      onSkip={undefined}
      isOffline={isOffline}
      oxyServices={oxyServices}
      backgroundColor={backgroundColor}
      textColor={textColor}
      isUpdating={isUpdatingProfile}
      updateError={updateError}
    />
  );
}
