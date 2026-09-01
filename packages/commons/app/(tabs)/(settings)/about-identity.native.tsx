import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Share, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { buildUserDid } from '@oxyhq/core';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { Screen, StackHeader, SessionGate } from '@/components/ui';
import { useOxy } from '@oxyhq/services';
import { alert, toast } from '@oxyhq/bloom';
import { useIdentity } from '@/hooks/useIdentity';
import { Fonts } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n';

/** Middle-truncate a long identifier for a list value: `048295c4…453da241`. */
function shorten(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * "About your identity" — the detail + settings surface for the device's
 * self-custody identity, reached from the ID tab. The visual ID card is the ID
 * tab's hero, so it is NOT repeated here. A clean iOS-style grouped list: the
 * technical identifiers (public key, DID) sit as tap-to-copy rows showing a
 * truncated value — never a raw hex dump — followed by the self-custody
 * explainer and the one account setting (inactivity expiration). Read + copy
 * only; actions (backup, rotate, delete) live in Settings.
 */
export default function AboutIdentityScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();
  // Auth is enforced by the layout for navigation; session-dependent rows are
  // gated below via SessionGate (cold boot may still be minting).
  const { user, oxyServices } = useOxy();
  const { getPublicKey } = useIdentity();

  const userId = user?.id ?? oxyServices?.getCurrentUserId() ?? null;
  const did = useMemo(() => (userId ? buildUserDid(userId) : null), [userId]);

  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSavingExpiration, setIsSavingExpiration] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (getPublicKey) {
          const pk = await getPublicKey();
          if (active) setPublicKey(pk);
        }
      } catch (err) {
        console.error('Failed to get public key:', err);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [getPublicKey]);

  // Copy on web (clipboard), share on native (the OS sheet includes Copy).
  const handleCopy = useCallback(
    async (value: string, successKey: string) => {
      if (Platform.OS === 'web') {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(t(successKey));
        } catch {
          toast.error(t('aboutIdentity.copyFailed'));
        }
      } else {
        try {
          await Share.share({ message: value });
        } catch {
          // Cancelled — don't show an error.
        }
      }
    },
    [t],
  );

  const formatExpirationSetting = useCallback(
    (days: number | null | undefined): string => {
      if (!days) return t('aboutIdentity.expiration.never');
      if (days === 365) return t('aboutIdentity.expiration.oneYear');
      return t('aboutIdentity.expiration.days', { count: days });
    },
    [t],
  );

  const currentExpirationDays = user?.accountExpiresAfterInactivityDays ?? null;

  const handleExpirationChange = useCallback(
    async (selectedDays: number | null) => {
      if (!oxyServices || !user) return;
      try {
        setIsSavingExpiration(true);
        await oxyServices.updateProfile({ accountExpiresAfterInactivityDays: selectedDays });
        toast.success(t('aboutIdentity.expirationUpdated'));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : t('aboutIdentity.expirationUpdateFailed');
        toast.error(message);
      } finally {
        setIsSavingExpiration(false);
      }
    },
    [oxyServices, user, t],
  );

  const showExpirationPicker = useCallback(() => {
    const options = [
      { label: t('aboutIdentity.expirationPicker.days30'), value: 30 },
      { label: t('aboutIdentity.expirationPicker.days90'), value: 90 },
      { label: t('aboutIdentity.expirationPicker.days180'), value: 180 },
      { label: t('aboutIdentity.expirationPicker.oneYear'), value: 365 },
      { label: t('aboutIdentity.expirationPicker.never'), value: null },
    ];

    alert(t('aboutIdentity.expirationPicker.title'), t('aboutIdentity.expirationPicker.message'), [
      ...options.map((option) => ({
        text: option.label,
        onPress: () => handleExpirationChange(option.value),
      })),
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [handleExpirationChange, t]);

  const selfCustodyItems = useMemo(
    () => [
      {
        id: 'private-key',
        icon: 'key-variant' as const,
        iconColor: colors.iconSuccess,
        title: t('aboutIdentity.items.privateKeyTitle'),
        subtitle: t('aboutIdentity.items.privateKeySubtitle'),
      },
      {
        id: 'no-password',
        icon: 'lock-off-outline' as const,
        iconColor: colors.iconInfo,
        title: t('aboutIdentity.items.noPasswordTitle'),
        subtitle: t('aboutIdentity.items.noPasswordSubtitle'),
      },
      {
        id: 'recovery',
        icon: 'text-box-outline' as const,
        iconColor: colors.iconWarning,
        title: t('aboutIdentity.items.recoveryTitle'),
        subtitle: t('aboutIdentity.items.recoverySubtitle'),
      },
      {
        id: 'decentralized',
        icon: 'web' as const,
        iconColor: colors.identityIconPublicKey,
        title: t('aboutIdentity.items.decentralizedTitle'),
        subtitle: t('aboutIdentity.items.decentralizedSubtitle'),
      },
    ],
    [colors.iconSuccess, colors.iconInfo, colors.iconWarning, colors.identityIconPublicKey, t],
  );

  // Right-side value + copy affordance for a tap-to-copy identifier row.
  const copyValue = useCallback(
    (short: string) => (
      <View style={styles.valueTrail}>
        <ThemedText style={[styles.valueText, { color: colors.textSecondary }]}>{short}</ThemedText>
        <MaterialCommunityIcons name="content-copy" size={16} color={colors.tint} />
      </View>
    ),
    [colors.textSecondary, colors.tint],
  );

  if (loading) {
    return (
      <Screen contentStyle={styles.flush}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>
            {t('aboutIdentity.loading')}
          </ThemedText>
        </View>
      </Screen>
    );
  }

  const renderBody = () => (
    <>
      {/* Technical identifiers — tap a row to copy the full value. */}
      <SettingsListGroup title={t('aboutIdentity.identifiersTitle')}>
        {publicKey && (
          <SettingsListItem
            icon={<MaterialCommunityIcons name="key-outline" size={22} color={colors.tint} />}
            title={t('aboutIdentity.publicKeyRow')}
            rightElement={copyValue(shorten(publicKey))}
            showChevron={false}
            onPress={() => handleCopy(publicKey, 'aboutIdentity.publicKeyCopied')}
          />
        )}
        {did && (
          <SettingsListItem
            icon={<MaterialCommunityIcons name="web" size={22} color={colors.tint} />}
            title={t('aboutIdentity.didRow')}
            rightElement={copyValue(shorten(did, 6, 4))}
            showChevron={false}
            onPress={() => handleCopy(did, 'aboutIdentity.didCopied')}
          />
        )}
      </SettingsListGroup>

      {/* Self-custody explainer */}
      <SettingsListGroup
        title={t('aboutIdentity.selfCustodyTitle')}
        footer={t('aboutIdentity.selfCustodyDescription')}
      >
        {selfCustodyItems.map((item) => (
          <SettingsListItem
            key={item.id}
            icon={<MaterialCommunityIcons name={item.icon} size={22} color={item.iconColor} />}
            title={item.title}
            description={item.subtitle}
            showChevron={false}
          />
        ))}
      </SettingsListGroup>

      {/* Account settings */}
      <SettingsListGroup title={t('aboutIdentity.accountSettings')}>
        <SettingsListItem
          icon={<MaterialCommunityIcons name="clock-outline" size={22} color={colors.tint} />}
          title={t('aboutIdentity.accountExpiration')}
          value={formatExpirationSetting(currentExpirationDays)}
          onPress={isSavingExpiration ? undefined : showExpirationPicker}
          showChevron={!isSavingExpiration}
          disabled={isSavingExpiration}
          rightElement={
            isSavingExpiration ? <ActivityIndicator size="small" color={colors.tint} /> : undefined
          }
        />
      </SettingsListGroup>

      <ThemedText style={[styles.footnote, { color: colors.textSecondary }]}>
        {t('aboutIdentity.importantNotice')}
      </ThemedText>
    </>
  );

  return (
    // Flush column — Bloom's SettingsListGroup owns its horizontal gutter; the
    // header + footnote are padded to align with it.
    <Screen contentStyle={styles.flush} gap={16}>
      <View style={styles.header}>
        <StackHeader
          title={t('aboutIdentity.title')}
          subtitle={t('aboutIdentity.subtitle')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back')}
        />
      </View>

      <SessionGate>{renderBody()}</SessionGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flush: { paddingHorizontal: 0 },
  header: { paddingHorizontal: 20, marginBottom: 16 },
  footnote: {
    fontSize: 12.5,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 4,
  },
  valueTrail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  valueText: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
});
