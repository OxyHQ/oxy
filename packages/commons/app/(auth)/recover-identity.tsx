import React, { useCallback, useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyManager, readIdentityMarker, type IdentityMarker, type IdentityRecoveryResult } from '@oxyhq/core';
import { alert, toast } from '@oxyhq/bloom';
import { useColors } from '@/hooks/useColors';
import { Button } from '@/components/ui';
import { CenteredState } from '@/components/ui/centered-state';
import { useTranslation } from '@/lib/i18n';
import {
  useOnboardingStatus,
  ONBOARDING_IDENTITY_QUERY_KEY,
  ONBOARDING_COMPLETE_QUERY_KEY,
  ONBOARDING_FLOW_QUERY_KEY,
  getOnboardingResumeHref,
} from '@/hooks/useOnboardingStatus';
import { persistOnboardingComplete, persistOnboardingFlow } from '@/hooks/identity/identityStore';
import { shortenKey } from '@/utils/shorten-key';

const RECOVERY_MARKER_QUERY_KEY = ['recover-identity', 'marker'] as const;

/**
 * Recover Identity screen.
 *
 * Reached ONLY when `useOnboardingStatus` reports `status === 'recovery'` — a
 * `lost` verdict: the identity KEYS are gone/unreadable but the independent
 * {@link readIdentityMarker} still records that an identity existed here
 * (keystore death / corruption). This screen NEVER shows the "Hello Human"
 * welcome and NEVER auto-creates — a lost identity is recovered, not replaced.
 *
 * On mount it runs the {@link KeyManager.attemptIdentityRecovery} ladder
 * (v2 backup slot → cross-app shared slot — both AndroidKeyStore-independent of
 * the dead primary key). On success it invalidates the onboarding probes and the
 * root Stack resumes normal routing. On failure it offers the two manual paths:
 * re-enter the 12-word recovery phrase, or destructively start over.
 */
export default function RecoverIdentityScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { status, onboardingFlow } = useOnboardingStatus();

  // The marker records the PUBLIC key of the lost identity — shown so the user
  // can recognize which account is being recovered. Read once; never changes
  // while this screen is mounted.
  const markerQuery = useQuery<IdentityMarker | null>({
    queryKey: RECOVERY_MARKER_QUERY_KEY,
    queryFn: readIdentityMarker,
    staleTime: Infinity,
    retry: false,
  });

  const invalidateOnboarding = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ONBOARDING_FLOW_QUERY_KEY }),
    ]);
  }, [queryClient]);

  const recovery = useMutation<IdentityRecoveryResult, Error>({
    mutationFn: () => KeyManager.attemptIdentityRecovery(),
    onSuccess: (result) => {
      if (result.recovered) {
        // Keys are back → let the shared probes re-read and the root Stack take
        // over routing (present → complete/in_progress).
        void invalidateOnboarding();
      }
    },
  });

  // Fire the ladder exactly once, and only for a genuine `lost` verdict — a
  // storage-locked (`unavailable`) state is handled by the retry UI in
  // `(auth)/index.tsx`, not here. `mutate` is referentially stable.
  const { mutate: runRecovery } = recovery;
  const attemptedRef = useRef(false);
  useEffect(() => {
    if (attemptedRef.current || status !== 'recovery') return;
    attemptedRef.current = true;
    runRecovery();
  }, [status, runRecovery]);

  const handleEnterPhrase = useCallback(() => {
    void persistOnboardingFlow('import');
    // The existing import flow restores from the 12-word phrase. Importing the
    // SAME identity is the sanctioned path; a different phrase triggers the
    // import guard's "different identity" confirmation.
    router.push('/(auth)/import-identity');
  }, [router]);

  const handleStartOver = useCallback(() => {
    alert(t('recovery.startOverConfirmTitle'), t('recovery.startOverConfirmBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('recovery.startOverConfirmCta'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              // This screen only exists when the primary pair is ALREADY gone
              // but the independent marker still exists. A non-force delete
              // calls `hasIdentity()`, sees no pair and returns before clearing
              // that marker, trapping the device on this screen forever.
              // The user just confirmed the destructive reset, so skip backup
              // and force-purge every generation, recovery slot and marker.
              await KeyManager.deleteIdentity(true, true, true);
              await Promise.all([
                persistOnboardingComplete(false),
                persistOnboardingFlow(null),
              ]);

              // Do not retain the lost marker or the old wizard choice in the
              // screen/query caches after storage has become genuinely blank.
              queryClient.removeQueries({ queryKey: RECOVERY_MARKER_QUERY_KEY });
              await invalidateOnboarding();
              router.replace('/(auth)');
            } catch (error) {
              console.error('[RecoverIdentity] Failed to erase local identity state', error);
              toast.error(t('recovery.startOverFailed'));
            }
          })();
        },
      },
    ]);
  }, [t, invalidateOnboarding, queryClient, router]);

  // Routing has moved on — leave this screen for the correct destination.
  // Recovery succeeded (present → complete): the root Stack swaps to (tabs);
  // render a neutral backdrop until it does.
  if (status === 'complete') {
    return <View style={[styles.container, { backgroundColor: colors.background }]} />;
  }
  // Present but not yet onboarded → resume the create flow (which detects the
  // existing identity and continues at the username step).
  if (status === 'in_progress') {
    return <Redirect href={getOnboardingResumeHref(onboardingFlow)} />;
  }
  // Genuinely blank now (start-over completed) → the fresh welcome entry.
  if (status === 'none') {
    return <Redirect href="/(auth)" />;
  }
  // Storage became unreadable → the retry UI lives on the (auth) index.
  if (status === 'unavailable') {
    return <Redirect href="/(auth)" />;
  }

  const markerKey = markerQuery.data?.publicKey;
  const isAttempting = !recovery.isSuccess && !recovery.isError;
  const recovered = recovery.data?.recovered === true;

  if (isAttempting || recovered) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <CenteredState
          loading
          title={recovered ? t('recovery.restoredTitle') : t('recovery.attemptingTitle')}
          body={recovered ? t('recovery.restoredBody') : t('recovery.attemptingBody')}
        />
      </View>
    );
  }

  // Ladder exhausted (or threw): offer the manual recovery paths.
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <CenteredState
        icon="shield-key-outline"
        iconColor={colors.textSecondary}
        title={t('recovery.failedTitle')}
        body={t('recovery.failedBody', {
          key: markerKey ? shortenKey(markerKey) : '—',
        })}
        action={
          <View style={styles.actions}>
            <Button variant="primary" onPress={handleEnterPhrase} style={styles.action}>
              {t('recovery.enterPhrase')}
            </Button>
            <Button variant="secondary" onPress={handleStartOver} style={styles.action}>
              {t('recovery.startOver')}
            </Button>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  actions: {
    width: '100%',
    gap: 12,
    marginTop: 8,
    paddingHorizontal: 24,
  },
  action: {
    width: '100%',
  },
});
