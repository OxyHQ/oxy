import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import {
  KeyManager,
  RecoveryPhraseService,
  IdentityAlreadyExistsError,
  IdentityUnavailableError,
  handleHttpError,
} from '@oxy.so/core';
import { alert } from '@oxy.so/bloom';
import { useColors } from '@/hooks/useColors';
import { Button, KeyboardAwareScrollViewWrapper } from '@/components/ui';
import { PhraseInputGrid } from '@/components/auth/PhraseInputGrid';
import { useTranslation } from '@/lib/i18n';
import { useIdentity } from '@/hooks/useIdentity';
import {
  useIdentityStore,
  persistOnboardingComplete,
  persistOnboardingFlow,
  persistIdentitySyncState,
} from '@/hooks/identity/identityStore';
import { RECOVERY_PHRASE_LENGTH } from '@/constants/auth';
import { extractAuthErrorMessage } from '@/utils/auth/errorUtils';
import { checkIfOffline } from '@/utils/auth/networkUtils';
import {
  ONBOARDING_IDENTITY_QUERY_KEY,
  ONBOARDING_COMPLETE_QUERY_KEY,
  ONBOARDING_FLOW_QUERY_KEY,
} from '@/hooks/useOnboardingStatus';

/**
 * Restore identity from the user's encrypted off-device backup.
 *
 * An alternative to retyping the recovery phrase into the manual importer: the
 * user still enters their phrase, but instead of re-deriving the key locally we
 * fetch + decrypt their Oxy-stored ciphertext via
 * `oxyServices.restoreFromEncryptedBackup`, which persists the recovered key on
 * this device. We then establish a session (register-if-needed + sign-in) via
 * `syncIdentity`, exactly like the manual import path.
 *
 * If a DIFFERENT identity already exists on this device, the SDK throws
 * `IdentityAlreadyExistsError` — we surface the same overwrite-consent prompt as
 * the manual importer before retrying with `{ overwrite: true }`.
 */
export default function RestoreFromBackupScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { oxyServices, clearSessionState } = useOxy();
  const { syncIdentity } = useIdentity();
  const queryClient = useQueryClient();
  const setRecoveryPhraseAcknowledgedPersisted = useIdentityStore(
    (state) => state.setRecoveryPhraseAcknowledged,
  );
  const setSynced = useIdentityStore((state) => state.setSynced);

  const [phraseWords, setPhraseWords] = useState<string[]>(
    () => new Array(RECOVERY_PHRASE_LENGTH).fill(''),
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleWordChange = useCallback((index: number, word: string) => {
    setPhraseWords((prev) => {
      const next = [...prev];
      next[index] = word.toLowerCase().trim();
      return next;
    });
    setError(null);
  }, []);

  const handlePaste = useCallback((text: string) => {
    const words = text.trim().toLowerCase().split(/\s+/);
    if (words.length === RECOVERY_PHRASE_LENGTH || words.length === 24) {
      setPhraseWords(words.slice(0, RECOVERY_PHRASE_LENGTH));
    }
  }, []);

  const runRestore = useCallback(
    async (phrase: string, overwrite: boolean) => {
      if (!oxyServices) return;
      setError(null);
      setIsLoading(true);
      try {
        // Overwrite replaces local keys — clear any stale session first so a
        // failed sync cannot leave the user authenticated as the OLD account.
        if (overwrite) {
          await clearSessionState();
        }

        await oxyServices.restoreFromEncryptedBackup(phrase, { overwrite });

        // Mirror importIdentity: reset the local onboarding milestone for the
        // freshly-restored identity so a stale flag from a prior account cannot
        // skip the username wizard.
        await persistOnboardingComplete(false);
        await persistOnboardingFlow('import');
        setSynced(false);
        await persistIdentitySyncState(false);

        // Persist the phrase the user just typed so Settings re-reveal matches
        // the restored identity (especially after an overwrite).
        try {
          await KeyManager.storeRecoveryMnemonic(phrase);
        } catch (mnemonicError) {
          console.warn('[restore-from-backup] Failed to persist recovery mnemonic for re-reveal', mnemonicError);
        }

        // The user typed the phrase by hand, so they unambiguously already hold
        // it — don't nag them to back it up on the Security screen.
        setRecoveryPhraseAcknowledgedPersisted(true);

        // Identity presence just flipped false → true. Refresh the shared
        // onboarding probes so routing reflects the restored identity.
        queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ONBOARDING_FLOW_QUERY_KEY });

        const offline = await checkIfOffline();
        if (offline) {
          router.replace('/(auth)/import-identity/notifications');
          return;
        }

        // Online: establish a session with the restored key (register-if-needed +
        // sign in). Do not advance on sync failure — username would call
        // authenticated APIs with no session (same guard as the phrase importer).
        try {
          await syncIdentity();
          await KeyManager.migrateToSharedIdentity();
          router.replace('/(auth)/import-identity/username');
        } catch {
          setError(t('restoreBackup.syncFailed'));
        }
      } catch (err: unknown) {
        if (err instanceof IdentityAlreadyExistsError) {
          // A different identity is on this device. Confirm before clobbering —
          // the same consent gate as the manual importer.
          alert(
            t('restoreBackup.overwriteTitle'),
            t('restoreBackup.overwriteBody'),
            [
              { text: t('restoreBackup.cancel'), style: 'cancel' },
              {
                text: t('restoreBackup.overwriteConfirm'),
                style: 'destructive',
                onPress: () => {
                  void runRestore(phrase, true);
                },
              },
            ],
          );
          return;
        }
        if (err instanceof IdentityUnavailableError) {
          router.replace('/(auth)');
          return;
        }
        // A 404 means no encrypted backup exists for the phrase's locator —
        // surface the specific "no backup found" copy instead of a raw message.
        if (handleHttpError(err).status === 404) {
          setError(t('restoreBackup.noBackup'));
          return;
        }
        setError(extractAuthErrorMessage(err, t('restoreBackup.failed')));
      } finally {
        setIsLoading(false);
      }
    },
    [oxyServices, clearSessionState, syncIdentity, queryClient, router, setRecoveryPhraseAcknowledgedPersisted, setSynced, t],
  );

  const handleRestore = useCallback(async () => {
    const phrase = phraseWords.join(' ');
    if (!RecoveryPhraseService.validatePhrase(phrase)) {
      setError(t('restoreBackup.invalidPhrase'));
      return;
    }

    const offline = await checkIfOffline();
    if (offline) {
      setError(t('restoreBackup.offline'));
      return;
    }

    void runRestore(phrase, false);
  }, [phraseWords, runRestore, t]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.title, { color: colors.text }]}>{t('restoreBackup.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.text, opacity: 0.6 }]}>
          {t('restoreBackup.subtitle')}
        </Text>

        <PhraseInputGrid
          words={phraseWords}
          onWordChange={handleWordChange}
          onPaste={handlePaste}
          editable={!isLoading}
        />

        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        <Button
          variant="primary"
          onPress={handleRestore}
          disabled={isLoading}
          loading={isLoading}
          style={styles.primaryButton}
        >
          {isLoading ? t('restoreBackup.restoring') : t('restoreBackup.restore')}
        </Button>

        <Button variant="ghost" onPress={() => router.back()} disabled={isLoading}>
          {t('common.back')}
        </Button>
      </KeyboardAwareScrollViewWrapper>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 60,
    justifyContent: 'center',
  },
  title: {
    fontSize: 34,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 32,
    lineHeight: 22,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 32,
  },
  errorText: {
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
  },
});
