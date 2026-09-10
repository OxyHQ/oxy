import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { InterestsStep } from '@/components/auth/InterestsStep';

/**
 * Create Identity - Interests Screen
 *
 * Sits between `recovery-phrase` and `username`. `createIdentity` has already
 * registered the account and opened a session by this point, so the selection
 * has an Oxy account to belong to — and this is the only slot where it is
 * REACHABLE: the root guard redirects the whole `(auth)` group away the moment
 * a username lands (`app/_layout.tsx`, `redirect={!needsAuth}`), so a step
 * placed after `username` never renders.
 */
export default function CreateIdentityInterestsScreen() {
  const router = useRouter();

  const handleContinue = useCallback(
    (_selectedIds: string[]) => {
      router.replace('/(auth)/create-identity/username');
    },
    [router]
  );

  return <InterestsStep onContinue={handleContinue} />;
}
