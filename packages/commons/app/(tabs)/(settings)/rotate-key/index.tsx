import React, { useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useColors } from '@/hooks/useColors';
import { Screen, StackHeader, ImportantBanner } from '@/components/ui';
import { useTranslation } from '@/lib/i18n';
import { useRotateKeyFlow } from '@/contexts/rotate-key-flow-context';

/**
 * Key-rotation entry: choose how to prove control of the current key.
 *
 *  - Path A ("Rotate with this device"): sign the rotation with the on-device
 *    key. The default when the key is healthy.
 *  - Path B ("My device key is lost"): re-derive the current key from the entered
 *    recovery phrase — the way to replace the LAST remaining credential.
 */
export default function RotateKeyEntryScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { setProof, reset } = useRotateKeyFlow();

  const handleDevice = useCallback(() => {
    reset();
    setProof('device');
    router.push('/(tabs)/(settings)/rotate-key/recovery-phrase');
  }, [reset, setProof, router]);

  const handlePhrase = useCallback(() => {
    reset();
    setProof('phrase');
    router.push('/(tabs)/(settings)/rotate-key/current-phrase');
  }, [reset, setProof, router]);

  return (
    // Flush column — Bloom's SettingsListGroup owns its horizontal gutter; the
    // header and banner are padded to align with it (see settings index).
    <Screen contentStyle={styles.flush} gap={16}>
      <View style={styles.header}>
        <StackHeader
          title={t('rotateKey.title')}
          subtitle={t('rotateKey.subtitle')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back')}
        />
      </View>

      <View style={styles.gutter}>
        <ImportantBanner title={t('rotateKey.warningTitle')} icon="alert-octagon">
          {t('rotateKey.warning')}
        </ImportantBanner>
      </View>

      <SettingsListGroup title={t('rotateKey.pathSection')}>
        <SettingsListItem
          icon={<MaterialCommunityIcons name="cellphone-key" size={22} color={colors.text} />}
          title={t('rotateKey.pathDevice')}
          description={t('rotateKey.pathDeviceSubtitle')}
          onPress={handleDevice}
        />
        <SettingsListItem
          icon={<MaterialCommunityIcons name="key-remove" size={22} color={colors.text} />}
          title={t('rotateKey.pathPhrase')}
          description={t('rotateKey.pathPhraseSubtitle')}
          onPress={handlePhrase}
        />
      </SettingsListGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flush: { paddingHorizontal: 0 },
  header: { paddingHorizontal: 20, marginBottom: 16 },
  gutter: { paddingHorizontal: 20 },
});
