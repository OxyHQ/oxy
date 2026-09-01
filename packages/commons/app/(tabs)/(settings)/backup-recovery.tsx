import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { KeyManager } from '@oxyhq/core';
import { Screen, StackHeader, Callout, Button } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';

/**
 * Backup & recovery hub.
 *
 * Single home for every way to back up and recover this identity, replacing the
 * scattered "Create an encrypted backup" and "View recovery phrase" rows that
 * used to sit as flat siblings in Settings. Both existing methods are derived
 * from the 12-word recovery phrase (mnemonic → seed → key + backup material), so
 * an identity IMPORTED from a raw private key has neither — it never had a
 * phrase, and the phrase cannot be re-derived from the key.
 *
 * Rather than show two dead rows to those users, the hub reads whether a phrase
 * was ever captured on this device ({@link KeyManager.getRecoveryMnemonic}) and
 * tells the honest story: phrase-backed identities get both actions; key-imported
 * identities are told why they're unavailable and pointed at key rotation (which
 * mints a fresh phrase-backed key). The existence check never renders or logs the
 * phrase itself — the reveal screen keeps its own biometric gate.
 */
type PhraseStatus = 'loading' | 'present' | 'absent';

export default function BackupRecoveryScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const [status, setStatus] = useState<PhraseStatus>('loading');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const mnemonic = await KeyManager.getRecoveryMnemonic();
        if (active) setStatus(mnemonic ? 'present' : 'absent');
      } catch {
        // A locked/unreadable keychain can't confirm absence — assume present so
        // we never wrongly tell a phrase-backed user they have no phrase. The
        // reveal screen surfaces the real "unavailable/retry" state on tap.
        if (active) setStatus('present');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleRecoveryPhrase = useCallback(() => {
    router.push('/(tabs)/(settings)/recovery-phrase');
  }, [router]);

  const handleCreateBackup = useCallback(() => {
    router.push('/(tabs)/(settings)/create-backup');
  }, [router]);

  const handleRotateKey = useCallback(() => {
    router.push('/(tabs)/(settings)/rotate-key');
  }, [router]);

  const noPhrase = status === 'absent';

  return (
    // Flush column — Bloom's SettingsListGroup owns its horizontal gutter; the
    // header and status callouts are padded to align with it (see settings index).
    <Screen contentStyle={styles.flush} gap={16}>
      <View style={styles.header}>
        <StackHeader
          title={t('backupRecovery.title')}
          subtitle={t('backupRecovery.subtitle')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back')}
        />
      </View>

      {status === 'present' && (
        <View style={styles.gutter}>
          <Callout tone="info" icon="shield-check">
            {t('backupRecovery.statusPresent')}
          </Callout>
        </View>
      )}

      {noPhrase && (
        <View style={[styles.gutter, styles.stack]}>
          <Callout tone="warning" icon="key-alert">
            {t('backupRecovery.statusAbsent')}
          </Callout>
          <Button variant="primary" onPress={handleRotateKey}>
            {t('backupRecovery.rotateCta')}
          </Button>
        </View>
      )}

      <SettingsListGroup title={t('backupRecovery.methodsTitle')}>
        <SettingsListItem
          icon={<MaterialCommunityIcons name="text-box-outline" size={22} color={colors.text} />}
          title={t('backupRecovery.phraseTitle')}
          description={
            noPhrase
              ? t('backupRecovery.phraseUnavailable')
              : t('backupRecovery.phraseSubtitle')
          }
          onPress={noPhrase ? undefined : handleRecoveryPhrase}
          showChevron={!noPhrase}
          disabled={noPhrase}
        />
        <SettingsListItem
          icon={<MaterialCommunityIcons name="file-lock-outline" size={22} color={colors.text} />}
          title={t('backupRecovery.encryptedTitle')}
          description={
            noPhrase
              ? t('backupRecovery.encryptedUnavailable')
              : t('backupRecovery.encryptedSubtitle')
          }
          onPress={noPhrase ? undefined : handleCreateBackup}
          showChevron={!noPhrase}
          disabled={noPhrase}
        />
      </SettingsListGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flush: { paddingHorizontal: 0 },
  header: { paddingHorizontal: 20, marginBottom: 16 },
  gutter: { paddingHorizontal: 20 },
  stack: { gap: 12 },
});
