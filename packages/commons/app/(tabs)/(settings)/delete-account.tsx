import React, { useCallback, useState } from 'react';
import { View, StyleSheet, TextInput, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { Section } from '@/components/section';
import { Button, ImportantBanner, KeyboardAwareScrollViewWrapper, ScreenHeader } from '@/components/ui';
import { useOxy } from '@oxyhq/services';
import { alert, toast } from '@oxyhq/bloom';
import { KeyManager } from '@oxyhq/core';
import { useTranslation } from '@/lib/i18n';
import { runAccountDeletion } from '@/lib/account/delete-account-flow';
import { retireVaultPushToken } from '@/lib/notifications/push-registration';
import { ONBOARDING_IDENTITY_QUERY_KEY, ONBOARDING_COMPLETE_QUERY_KEY, ONBOARDING_FLOW_QUERY_KEY } from '@/hooks/useOnboardingStatus';
import { persistOnboardingComplete, persistOnboardingFlow } from '@/hooks/identity/identityStore';

/**
 * Account Deletion Screen.
 *
 * Permanent, irreversible. The API requires a cryptographic signature
 * produced by this device's identity private key — there is no password.
 * The user must also type their username verbatim as a confirmation.
 */
export default function DeleteAccountScreen() {
  const colors = useColors();
  const router = useRouter();
  // Auth is enforced by the `(vault)` layout — assume a session here.
  const { user, isLoading: oxyLoading, oxyServices, logoutAll } = useOxy();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const username = user?.username ?? '';
  const isConfirmValid = confirmText === username && username.length > 0;

  const handleDelete = useCallback(async () => {
    if (!isConfirmValid || !oxyServices) return;

    setIsDeleting(true);
    try {
      // Pre-flight: identity key must exist on this device to sign the delete
      // request. `hasIdentity()` now THROWS `IdentityUnavailableError` when
      // storage is locked/unreadable — that is an INDETERMINATE read, not proof
      // the identity is gone, so we ABORT the deletion with a visible error and
      // NEVER fall through to the purge on an unreadable keystore.
      let identityReadable: boolean;
      try {
        identityReadable = await KeyManager.hasIdentity();
      } catch (probeError) {
        const message = probeError instanceof Error
          ? probeError.message
          : t('data.deleteAccount.failedDefault');
        toast.error(message);
        return;
      }
      if (!identityReadable) {
        alert(
          t('data.deleteAccount.identityRequiredTitle'),
          t('data.deleteAccount.identityRequiredMessage'),
        );
        return;
      }

      // Retire the push token (bearer still valid) → server-side delete → purge
      // the local identity (primary + backup) → sign out. The purge runs ONLY
      // after the server confirms deletion, so a failed delete never strands the
      // user without their keys. See `runAccountDeletion` for the full
      // ordering/safety contract.
      const { localIdentityPurged } = await runAccountDeletion(confirmText, {
        // Must precede the delete: the registry scopes the retirement to the
        // authenticated identity, so this device would otherwise keep a live
        // registration for the account being destroyed.
        retirePushToken: () => retireVaultPushToken(oxyServices),
        deleteAccount: (text) => oxyServices.deleteAccount(text),
        // skipBackup=true (no point backing up keys for a deleted account),
        // force=true (also purges the backup slot, no re-prompt), and
        // userConfirmed=true (the user already confirmed via username match +
        // the cryptographic signature this device produced).
        purgeIdentity: () => KeyManager.deleteIdentity(true, true, true),
        signOutAll: () => logoutAll(),
      });

      // The local identity has been purged (or the purge was attempted) — re-sync
      // the shared onboarding probe to ground truth so routing doesn't resume a
      // deleted account's stale identity. Also clear the local onboarding-complete
      // milestone so a subsequent re-onboard on this device starts fresh (the
      // identity-presence check gates first, but keep storage coherent).
      await persistOnboardingComplete(false);
      await persistOnboardingFlow(null);
      queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ONBOARDING_FLOW_QUERY_KEY });

      // The account is gone server-side regardless. If the local key purge
      // failed, surface a non-fatal warning so the user knows to reinstall to
      // fully clear residual key material.
      if (!localIdentityPurged) {
        toast.error(t('data.deleteAccount.localKeyPurgeWarning'));
      }

      router.replace('/');
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : t('data.deleteAccount.failedDefault');
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }, [isConfirmValid, oxyServices, confirmText, logoutAll, router, alert, t, queryClient]);

  if (oxyLoading) {
    return (
      <View style={[styles.center, styles.flex, { backgroundColor: colors.background }]}>
        <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('common.loadingShort')}</ThemedText>
      </View>
    );
  }

  const renderContent = () => (
    <>
      <ScreenHeader
        title={t('data.deleteAccount.title')}
        subtitle={t('data.deleteAccount.subtitle')}
      />

      <ImportantBanner title={t('data.deleteAccount.permanentTitle')} icon="alert-octagon">
        {t('data.deleteAccount.permanentBody', { name: username || t('data.deleteAccount.thisAccount') })}
      </ImportantBanner>

      <Section title={t('data.deleteAccount.whatDeleted')}>
        <View style={[styles.bulletList, { backgroundColor: colors.card }]}>
          {[
            t('data.deleteAccount.items.profile'),
            t('data.deleteAccount.items.mailboxes'),
            t('data.deleteAccount.items.sessions'),
            t('data.deleteAccount.items.settings'),
          ].map((item) => (
            <View key={item} style={styles.bulletRow}>
              <MaterialCommunityIcons
                name="close-circle-outline"
                size={18}
                color={colors.error}
                style={styles.bulletIcon}
              />
              <ThemedText style={[styles.bulletText, { color: colors.text }]}>{item}</ThemedText>
            </View>
          ))}
        </View>
      </Section>

      <Section title={t('data.deleteAccount.confirm')}>
        <ThemedText style={[styles.label, { color: colors.text }]}>
          {t('data.deleteAccount.typeUsername')} <ThemedText style={[styles.usernameHint, { color: colors.error }]}>{username}</ThemedText>
        </ThemedText>
        <View
          style={[
            styles.inputWrapper,
            {
              backgroundColor: colors.card,
              borderColor: confirmText.length > 0 && !isConfirmValid ? colors.error : colors.border,
            },
          ]}
        >
          <TextInput
            style={[styles.input, { color: colors.text }]}
            value={confirmText}
            onChangeText={setConfirmText}
            placeholder={username}
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isDeleting}
            accessibilityLabel={t('data.deleteAccount.confirmInputLabel')}
          />
        </View>
        {confirmText.length > 0 && !isConfirmValid && (
          <ThemedText style={[styles.errorText, { color: colors.error }]}>
            {t('data.deleteAccount.usernameMismatch')}
          </ThemedText>
        )}

        <View style={styles.buttonRow}>
          <Button
            variant="secondary"
            onPress={() => router.back()}
            disabled={isDeleting}
            style={styles.buttonFlex}
          >
            {t('data.deleteAccount.cancel')}
          </Button>
          <Button
            variant="primary"
            onPress={handleDelete}
            loading={isDeleting}
            disabled={!isConfirmValid || isDeleting}
            style={styles.buttonFlex}
          >
            {isDeleting ? t('data.deleteAccount.deleting') : t('data.deleteAccount.deleteCta')}
          </Button>
        </View>
      </Section>
    </>
  );

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.flex, styles.scrollContent, { backgroundColor: colors.background }]}>
        {renderContent()}
      </View>
    );
  }

  return (
    <KeyboardAwareScrollViewWrapper
      reserveTabBarFootprint
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.scrollContent}
    >
      {renderContent()}
    </KeyboardAwareScrollViewWrapper>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    flexGrow: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
  bulletList: {
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  bulletIcon: {
    marginTop: 2,
    marginRight: 10,
  },
  bulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  usernameHint: {
    fontWeight: '700',
  },
  inputWrapper: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  input: {
    fontSize: 16,
    paddingVertical: 12,
  },
  errorText: {
    fontSize: 12,
    marginTop: 6,
    marginLeft: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
  buttonFlex: {
    flex: 1,
  },
});
