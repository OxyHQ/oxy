import React, { useCallback, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { KeyManager, IdentityUnavailableError } from '@oxyhq/core';
import { Screen, StackHeader, Section, Button, Callout, CenteredState } from '@/components/ui';
import { ThemedText } from '@/components/themed-text';
import { RecoveryPhraseGrid } from '@/components/identity/RecoveryPhraseGrid';
import { useColors } from '@/hooks/useColors';
import { authenticate, canUseBiometrics, getErrorMessage } from '@/lib/biometricAuth';
import { useTranslation } from '@/lib/i18n';

/**
 * Settings → Recovery phrase re-reveal.
 *
 * Re-reveals the 12-word phrase that was captured (best-effort) at identity
 * creation/import and persisted in a dedicated, device-only keychain slot
 * ({@link KeyManager.getRecoveryMnemonic}). Gated behind the device biometric /
 * passcode when biometrics are available.
 *
 * The phrase is loaded ONLY after the gate passes and is never persisted to any
 * other store, copied, or logged. Identities created before this feature existed
 * never captured a phrase here — those surface the "not stored" explanation
 * rather than an error, since the phrase cannot be re-derived from the keys.
 */
type RevealState =
  | { kind: 'idle' }
  | { kind: 'authenticating' }
  | { kind: 'revealed'; words: string[] }
  | { kind: 'notStored' }
  | { kind: 'unavailable' }
  | { kind: 'gateFailed'; message: string };

export default function RecoveryPhraseScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useColors();
  const [state, setState] = useState<RevealState>({ kind: 'idle' });

  const reveal = useCallback(async () => {
    setState({ kind: 'authenticating' });

    // Biometric/passcode gate when biometrics are available. A device WITHOUT
    // enrolled biometrics is already unlocked (the device-only keychain read
    // below only succeeds while the device is unlocked), so we don't lock those
    // users out of their own phrase.
    const canUse = await canUseBiometrics();
    if (canUse) {
      const auth = await authenticate(t('settings.recoveryPhrase.biometricReason'));
      if (!auth.success) {
        setState({ kind: 'gateFailed', message: getErrorMessage(auth.error) });
        return;
      }
    }

    try {
      const mnemonic = await KeyManager.getRecoveryMnemonic();
      if (!mnemonic) {
        setState({ kind: 'notStored' });
        return;
      }
      setState({ kind: 'revealed', words: mnemonic.trim().split(/\s+/) });
    } catch (error) {
      // A locked/unreadable keychain throws IdentityUnavailableError — a retriable
      // "try again once unlocked" condition, NOT "the phrase was never stored".
      if (!(error instanceof IdentityUnavailableError)) {
        console.error('[RecoveryPhrase] Failed to read recovery mnemonic', error);
      }
      setState({ kind: 'unavailable' });
    }
  }, [t]);

  const hide = useCallback(() => setState({ kind: 'idle' }), []);
  const handleBack = useCallback(() => router.back(), [router]);

  return (
    <Screen>
      <StackHeader
        title={t('settings.recoveryPhrase.title')}
        subtitle={t('settings.recoveryPhrase.subtitle')}
        onBack={handleBack}
        backAccessibilityLabel={t('common.back')}
      />

      {state.kind === 'revealed' ? (
        <Section>
          <Callout tone="danger" icon="alert-octagon">
            {t('settings.recoveryPhrase.warning')}
          </Callout>

          <View
            style={[styles.phraseGrid, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <RecoveryPhraseGrid words={state.words} textColor={colors.text} />
          </View>

          <ThemedText style={[styles.copyWarning, { color: colors.warning }]}>
            {t('settings.recoveryPhrase.copyWarning')}
          </ThemedText>

          <Button variant="secondary" onPress={hide}>
            {t('settings.recoveryPhrase.hide')}
          </Button>
        </Section>
      ) : state.kind === 'notStored' ? (
        <CenteredState
          icon="text-box-remove-outline"
          title={t('settings.recoveryPhrase.notStoredTitle')}
          body={t('settings.recoveryPhrase.notStoredBody')}
        />
      ) : state.kind === 'unavailable' ? (
        <CenteredState
          icon="shield-lock-outline"
          title={t('settings.recoveryPhrase.unavailableTitle')}
          body={t('settings.recoveryPhrase.unavailableBody')}
          action={
            <Button variant="primary" onPress={reveal}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : state.kind === 'gateFailed' ? (
        <CenteredState
          icon="lock-alert-outline"
          iconColor={colors.error}
          title={t('settings.recoveryPhrase.gateFailedTitle')}
          body={state.message}
          action={
            <Button variant="primary" onPress={reveal}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <Section>
          <View style={styles.lockedHeader}>
            <MaterialCommunityIcons name="shield-key" size={40} color={colors.tint} />
            <ThemedText style={[styles.lockedTitle, { color: colors.text }]}>
              {t('settings.recoveryPhrase.lockedTitle')}
            </ThemedText>
            <ThemedText style={[styles.lockedBody, { color: colors.textSecondary }]}>
              {t('settings.recoveryPhrase.lockedBody')}
            </ThemedText>
          </View>

          <Callout tone="warning" icon="alert-octagon">
            {t('settings.recoveryPhrase.warning')}
          </Callout>

          <Button
            variant="primary"
            onPress={reveal}
            loading={state.kind === 'authenticating'}
            disabled={state.kind === 'authenticating'}
          >
            {t('settings.recoveryPhrase.revealButton')}
          </Button>
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  lockedHeader: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  lockedTitle: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 4,
  },
  lockedBody: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  phraseGrid: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  copyWarning: {
    fontSize: 12,
    textAlign: 'center',
    fontStyle: 'italic',
  },
});
