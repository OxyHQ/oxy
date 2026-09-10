import React, { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'expo-router';
import {
  RecoveryPhraseService,
  IdentityAlreadyExistsError,
  IdentityUnavailableError,
} from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { ImportPhraseStep } from '@/components/auth/ImportPhraseStep';
import { extractAuthErrorMessage } from '@/utils/auth/errorUtils';
import { checkIfOffline } from '@/utils/auth/networkUtils';
import { RECOVERY_PHRASE_LENGTH } from '@/constants/auth';
import { useAuthFlowContext } from '@/contexts/auth-flow-context';
import { useIdentity } from '@/hooks/useIdentity';
import { useIdentityStore, persistOnboardingFlow } from '@/hooks/identity/identityStore';
import { IdentityMayExistError } from '@/hooks/identity/identityErrors';
import { useTranslation } from '@/lib/i18n';

/**
 * Import Identity - Phrase Screen (Index)
 *
 * Allows user to enter recovery phrase to import identity
 */
export default function ImportIdentityPhraseScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { importIdentity } = useIdentity();
  const { error, setAuthError } = useAuthFlowContext();
  const setRecoveryPhraseAcknowledgedPersisted = useIdentityStore(
    (state) => state.setRecoveryPhraseAcknowledged,
  );
  const [isLoading, setIsLoading] = useState(false);

  const backgroundColor = colors.background;
  const textColor = colors.text;

  const [phraseWords, setPhraseWords] = useState<string[]>(new Array(RECOVERY_PHRASE_LENGTH).fill(''));

  useEffect(() => {
    void persistOnboardingFlow('import');
  }, []);

  const handleRestoreFromBackup = useCallback(() => {
    setAuthError(null);
    router.push('/(auth)/import-identity/restore-from-backup');
  }, [router, setAuthError]);

  const handleImportPrivateKey = useCallback(() => {
    setAuthError(null);
    router.push('/(auth)/import-identity/private-key');
  }, [router, setAuthError]);

  const handleWordChange = useCallback((index: number, word: string) => {
    setPhraseWords(prev => {
      const newWords = [...prev];
      newWords[index] = word.toLowerCase().trim();
      return newWords;
    });
    setAuthError(null);
  }, [setAuthError]);

  const handlePaste = useCallback((text: string) => {
    const words = text.trim().toLowerCase().split(/\s+/);
    if (words.length === RECOVERY_PHRASE_LENGTH || words.length === 24) {
      setPhraseWords(words.slice(0, RECOVERY_PHRASE_LENGTH));
    }
  }, []);

  const handleImport = useCallback(async () => {
    const phrase = phraseWords.join(' ');

    if (!RecoveryPhraseService.validatePhrase(phrase)) {
      setAuthError(t('auth.errors.invalidPhrase'));
      return;
    }

    setAuthError(null);
    setIsLoading(true);

    try {
      const offline = await checkIfOffline();
      const result = await importIdentity(phrase, { skipSync: offline });

      // Online but server sync failed: do not advance — username would call
      // authenticated APIs with no session (same guard as create-identity).
      if (!offline && !result.synced) {
        setAuthError(t('auth.errors.importSyncFailed'));
        return;
      }

      // The user just typed the phrase by hand, so they unambiguously
      // already have it written down somewhere. Mark it as acknowledged
      // so the security screen doesn't nag them about a backup they
      // already possess.
      setRecoveryPhraseAcknowledgedPersisted(true);

      // Offline: skip username (deferred until reconnect). Online: choose username.
      if (offline) {
        router.replace('/(auth)/import-identity/notifications');
      } else {
        router.replace('/(auth)/import-identity/username');
      }
    } catch (err: unknown) {
      if (err instanceof IdentityMayExistError) {
        router.replace('/(auth)/recover-identity');
        return;
      }
      if (err instanceof IdentityUnavailableError) {
        router.replace('/(auth)');
        return;
      }
      if (err instanceof IdentityAlreadyExistsError) {
        // The user is trying to import a different identity on top of an
        // existing one. We don't quietly clobber — they must use the
        // settings UI to remove the current identity (with a written
        // recovery phrase warning) before importing a new one.
        setAuthError(t('auth.errors.identityAlreadyExists'));
      } else {
        setAuthError(extractAuthErrorMessage(err, t('auth.errors.importFailed')));
      }
    } finally {
      setIsLoading(false);
    }
  }, [phraseWords, importIdentity, router, setAuthError, setRecoveryPhraseAcknowledgedPersisted, t]);

  return (
    <ImportPhraseStep
      phraseWords={phraseWords}
      onWordChange={handleWordChange}
      onPaste={handlePaste}
      onImport={handleImport}
      onRestoreFromBackup={handleRestoreFromBackup}
      onImportPrivateKey={handleImportPrivateKey}
      error={error}
      isLoading={isLoading}
      backgroundColor={backgroundColor}
      textColor={textColor}
    />
  );
}

