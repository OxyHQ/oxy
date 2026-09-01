import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useOxy } from '@oxyhq/services';
import { KeyManager, RecoveryPhraseService } from '@oxyhq/core';
import { alert, toast } from '@oxyhq/bloom';
import { useColors } from '@/hooks/useColors';
import { Button, ImportantBanner, Callout, KeyboardAwareScrollViewWrapper, StackHeader } from '@/components/ui';
import { PhraseInputGrid } from '@/components/auth/PhraseInputGrid';
import { useTranslation } from '@/lib/i18n';
import { authenticate } from '@/lib/biometricAuth';
import { RECOVERY_PHRASE_LENGTH } from '@/constants/auth';
import { useRelativeTime } from '@/hooks/useRelativeTime';

type IdentityStatus = 'checking' | 'present' | 'missing' | 'unavailable';

/** Minimal shape of `GET /identity/backup/status`, mirrored to avoid a cross-package type import. */
interface BackupStatus {
  exists: boolean;
  publicKeyHint?: string;
  createdAt?: string;
}

/**
 * Encrypted off-device backup management (b3 Feature 1).
 *
 * Replaces the old plaintext-key ZIP/PDF export. The user re-enters their
 * EXISTING recovery phrase (never re-derived — they must already know it); we
 * derive the encryption key from it locally and upload only ciphertext via
 * `oxyServices.createEncryptedBackup`. Oxy stores the ciphertext only — never
 * the phrase, the derived key, or the private key.
 *
 * The screen also surfaces the current backup status (exists / public-key hint /
 * created-at) and lets the user delete it.
 */
export default function CreateBackupScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const formatRelative = useRelativeTime();

  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>('checking');
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [phraseWords, setPhraseWords] = useState<string[]>(
    () => new Array(RECOVERY_PHRASE_LENGTH).fill(''),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // One-shot load: confirm the device holds an identity, capture its public key
  // (for the phrase-match guard), and fetch the current backup status.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const verdict = await KeyManager.getIdentityStatus({ bypassCache: true });
      if (cancelled) return;

      if (verdict.state === 'absent' || verdict.state === 'lost') {
        setIdentityStatus('missing');
        return;
      }
      if (verdict.state === 'unavailable') {
        setIdentityStatus('unavailable');
        return;
      }

      setIdentityStatus('present');

      if (!oxyServices) return;
      try {
        const status = await oxyServices.getBackupStatus();
        if (!cancelled) setBackupStatus(status);
      } catch {
        // A failed status fetch is non-fatal — the user can still create a
        // backup. Leave `backupStatus` null so the UI shows the neutral state.
        if (!cancelled) setBackupStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [oxyServices]);

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

  const handleCreate = useCallback(async () => {
    if (!oxyServices) return;
    const phrase = phraseWords.join(' ');

    if (!RecoveryPhraseService.validatePhrase(phrase)) {
      setError(t('backup.invalidPhrase'));
      return;
    }

    // Guard: the entered phrase must derive the SAME identity that lives on this
    // device — otherwise the user would silently back up the wrong key.
    try {
      const verdict = await KeyManager.getIdentityStatus({ bypassCache: true });
      if (verdict.state === 'unavailable') {
        setError(t('backup.identityUnavailable'));
        return;
      }
      if (verdict.state !== 'present') {
        setError(t('backup.phraseMismatch'));
        return;
      }

      const derived = await RecoveryPhraseService.derivePublicKeyFromPhrase(phrase);
      if (derived.toLowerCase() !== verdict.publicKey.toLowerCase()) {
        setError(t('backup.phraseMismatch'));
        return;
      }
    } catch {
      setError(t('backup.invalidPhrase'));
      return;
    }

    // Biometric/passcode gate before handling the key material.
    const auth = await authenticate(t('backup.biometricReason'));
    if (!auth.success) {
      toast.error(t('backup.biometricFailed'));
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const status = await oxyServices.createEncryptedBackup(phrase);
      setBackupStatus(status);
      setPhraseWords(new Array(RECOVERY_PHRASE_LENGTH).fill(''));
      toast.success(t('backup.createSuccess'));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('backup.createFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }, [oxyServices, phraseWords, t]);

  const handleDelete = useCallback(() => {
    if (!oxyServices) return;
    alert(
      t('backup.deleteConfirmTitle'),
      t('backup.deleteConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('backup.delete'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setIsDeleting(true);
              try {
                await oxyServices.deleteBackup();
                setBackupStatus({ exists: false });
                toast.success(t('backup.deleteSuccess'));
              } catch (err: unknown) {
                toast.error(err instanceof Error ? err.message : t('backup.deleteFailed'));
              } finally {
                setIsDeleting(false);
              }
            })();
          },
        },
      ],
    );
  }, [oxyServices, t]);

  if (identityStatus === 'checking') {
    return (
      <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.content}>
        <StackHeader
          title={t('backup.title')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back')}
        />
        <Text style={[styles.muted, { color: colors.textSecondary }]}>{t('backup.checkingStatus')}</Text>
      </KeyboardAwareScrollViewWrapper>
    );
  }

  if (identityStatus === 'unavailable') {
    return (
      <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.content}>
        <StackHeader
          title={t('backup.title')}
          subtitle={t('backup.unavailableSubtitle')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back')}
        />
        <ImportantBanner iconSize={20}>{t('backup.identityUnavailable')}</ImportantBanner>
        <Button variant="primary" onPress={() => router.back()}>
          {t('backup.goBack')}
        </Button>
      </KeyboardAwareScrollViewWrapper>
    );
  }

  if (identityStatus === 'missing') {
    return (
      <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.content}>
        <StackHeader
          title={t('backup.missingTitle')}
          subtitle={t('backup.missingSubtitle')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back')}
        />
        <ImportantBanner iconSize={20}>{t('backup.missingBanner')}</ImportantBanner>
        <View style={styles.buttonRow}>
          <Button variant="secondary" onPress={() => router.back()} style={styles.buttonFlex}>
            {t('backup.goBack')}
          </Button>
          <Button
            variant="primary"
            onPress={() => router.replace('/(auth)/welcome')}
            style={styles.buttonFlex}
          >
            {t('backup.setupIdentity')}
          </Button>
        </View>
      </KeyboardAwareScrollViewWrapper>
    );
  }

  const backupExists = backupStatus?.exists === true;

  return (
    <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.content}>
      <StackHeader
        title={t('backup.title')}
        subtitle={t('backup.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />

      {/* Current backup status */}
      <View style={[styles.statusCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.statusRow}>
          <MaterialCommunityIcons
            name={backupExists ? 'cloud-check' : 'cloud-off-outline'}
            size={22}
            color={backupExists ? colors.success : colors.textSecondary}
          />
          <Text style={[styles.statusTitle, { color: colors.text }]}>
            {backupExists ? t('backup.existsTrue') : t('backup.existsFalse')}
          </Text>
        </View>
        {backupExists && backupStatus?.publicKeyHint && (
          <Text style={[styles.statusMeta, { color: colors.textSecondary }]}>
            {t('backup.identityHint', { hint: backupStatus.publicKeyHint })}
          </Text>
        )}
        {backupExists && backupStatus?.createdAt && (
          <Text style={[styles.statusMeta, { color: colors.textSecondary }]}>
            {t('backup.createdAt', { date: formatRelative(backupStatus.createdAt) })}
          </Text>
        )}
        {backupExists && (
          <Button
            variant="ghost"
            onPress={handleDelete}
            loading={isDeleting}
            disabled={isDeleting || isSubmitting}
            style={styles.deleteButton}
          >
            {isDeleting ? t('backup.deleting') : t('backup.delete')}
          </Button>
        )}
      </View>

      <Callout icon="shield-lock-outline" tone="info">
        {t('backup.howItWorks')}
      </Callout>

      {/* Phrase re-prompt */}
      <View style={styles.phraseSection}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          {t('backup.enterPhraseTitle')}
        </Text>
        <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
          {t('backup.enterPhraseSubtitle')}
        </Text>

        <PhraseInputGrid
          words={phraseWords}
          onWordChange={handleWordChange}
          onPaste={handlePaste}
          editable={!isSubmitting}
        />

        {error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}

        <Button
          variant="primary"
          onPress={handleCreate}
          loading={isSubmitting}
          disabled={isSubmitting || isDeleting}
          style={styles.primaryButton}
        >
          {isSubmitting
            ? t('backup.creating')
            : backupExists
              ? t('backup.replace')
              : t('backup.create')}
        </Button>
      </View>
    </KeyboardAwareScrollViewWrapper>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 22,
    paddingTop: 24,
    paddingBottom: 120,
    gap: 20,
  },
  muted: {
    fontSize: 15,
  },
  statusCard: {
    borderWidth: 1,
    borderRadius: 16,
    borderCurve: 'continuous',
    padding: 16,
    gap: 6,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  statusMeta: {
    fontSize: 13,
    lineHeight: 18,
  },
  deleteButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  phraseSection: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  sectionSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  errorText: {
    fontSize: 13,
    marginTop: 8,
  },
  primaryButton: {
    marginTop: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  buttonFlex: {
    flex: 1,
  },
});
