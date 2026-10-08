import { useState, useEffect, useCallback, useRef } from 'react';
import { useOxy, useUpdateProfile } from '@oxy.so/services';
import { generateSuggestedUsername } from '@/utils/auth/usernameUtils';
import { useAuthFlowContext } from '@/contexts/auth-flow-context';
import { checkIfOffline } from '@/utils/auth/networkUtils';
import { extractAuthErrorMessage, isNetworkOrTimeoutError } from '@/utils/auth/errorUtils';
import { useSyncIdentity } from '@/hooks/identity/useSyncIdentity';
import { getPendingUsernameFromStorage, persistPendingUsername } from '@/hooks/identity/identityStore';
import { isUsernameTakenError } from '@/hooks/identity/identityErrors';
import { useTranslation } from '@/lib/i18n';

const SYNC_IN_PROGRESS_MESSAGE = 'Sync already in progress';

/**
 * The username step of both onboarding wizards (create and import).
 *
 * The username is what CREATES the account: `POST /auth/register` carries it,
 * so a key without an account is registered here, with the username, in one
 * request (`syncIdentity({ username })` → register + key sign-in). No account
 * ever exists without a username, and none exists before this step. The
 * availability check is public (`auth.checkUsername`), so the step needs no
 * session.
 *
 * Offline, the choice is kept as the pending username (secure storage) and the
 * step says so; the reconnect sync (`useNetworkReconnect` → `syncIdentity`)
 * registers with it, and the onboarding guard then leaves the wizard.
 *
 * A key that already has an account and a session (an imported key) only sets
 * its username, through the `useUpdateProfile` mutation — NOT a direct
 * `users.updateMe` call — whose optimistic cache write keeps the root guard
 * from seeing a stale username-less user and bouncing the wizard.
 */
export function useUsernameStep({ onDone }: { onDone: () => void }) {
  const { oxyServices, user } = useOxy();
  const { error: authFlowError, setAuthError } = useAuthFlowContext();
  const { syncIdentity } = useSyncIdentity();
  const updateProfile = useUpdateProfile();
  const { t } = useTranslation();

  // Initialise once per mount, so re-renders never visibly regenerate the
  // suggestion. A username chosen earlier (the pending one, read below — kept
  // whenever Continue tries to create the account) wins over a fresh one.
  const [username, setUsernameState] = useState<string>(
    () => user?.username || generateSuggestedUsername(),
  );
  const editedRef = useRef(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  const setUsername = useCallback((value: string) => {
    editedRef.current = true;
    setUsernameState(value);
  }, []);

  // A username chosen offline (or before quitting) is still the user's choice.
  useEffect(() => {
    if (user?.username) return;
    let cancelled = false;
    void getPendingUsernameFromStorage().then((pending) => {
      if (!cancelled && pending && !editedRef.current) setUsernameState(pending);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.username]);

  const handleContinue = useCallback(async () => {
    const chosen = username.trim();
    if (!oxyServices || !chosen) return;
    setUpdateError(null);
    // A sync error stashed by the resume path is shown until the next attempt.
    setAuthError(null);

    // The account already exists and is signed in: set its username.
    if (oxyServices.session.accessToken) {
      try {
        await updateProfile.mutateAsync({ username: chosen });
        onDone();
      } catch (err: unknown) {
        const offline = await checkIfOffline();
        setUpdateError(
          offline && isNetworkOrTimeoutError(err)
            ? t('auth.usernameStep.offlineRetry')
            : extractAuthErrorMessage(err, t('auth.usernameStep.saveFailed')),
        );
      }
      return;
    }

    // No account yet: create it now, with this username. Offline, keep the
    // choice; the reconnect sync registers with it.
    if (await checkIfOffline()) {
      await persistPendingUsername(chosen);
      setUpdateError(t('auth.usernameStep.savedOffline'));
      return;
    }

    setIsRegistering(true);
    try {
      await syncIdentity({ username: chosen });
      onDone();
    } catch (err: unknown) {
      if (isUsernameTakenError(err)) {
        setUpdateError(t('auth.usernameStep.taken'));
      } else if (isNetworkOrTimeoutError(err)) {
        setUpdateError(t('auth.usernameStep.savedOffline'));
      } else if (err instanceof Error && err.message.includes(SYNC_IN_PROGRESS_MESSAGE)) {
        // The reconnect sync is registering right now; it finishes on its own.
        setUpdateError(t('auth.usernameStep.finishingSetup'));
      } else {
        setUpdateError(extractAuthErrorMessage(err, t('auth.usernameStep.saveFailed')));
      }
    } finally {
      setIsRegistering(false);
    }
  }, [username, oxyServices, updateProfile, syncIdentity, onDone, setAuthError, t]);

  return {
    username,
    setUsername,
    handleContinue,
    oxyServices,
    isUpdating: updateProfile.isPending || isRegistering,
    updateError: updateError ?? authFlowError,
  };
}
