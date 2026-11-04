import { useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Icons } from '@/constants/icons';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { useColors } from '@/hooks/useColors';
import { Screen, StackHeader, ImportantBanner, SettingsListItem } from '@/components/ui';
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
    <Screen gap={16}>
      <StackHeader
        title={t('rotateKey.title')}
        subtitle={t('rotateKey.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />

      <View>
        <ImportantBanner title={t('rotateKey.warningTitle')}>
          {t('rotateKey.warning')}
        </ImportantBanner>
      </View>

      <SettingsListGroup title={t('rotateKey.pathSection')}>
        <SettingsListItem
          icon={<Icons.device size="md" fill={colors.text} />}
          title={t('rotateKey.pathDevice')}
          description={t('rotateKey.pathDeviceSubtitle')}
          onPress={handleDevice}
        />
        <SettingsListItem
          icon={<Icons.key size="md" fill={colors.text} />}
          title={t('rotateKey.pathPhrase')}
          description={t('rotateKey.pathPhraseSubtitle')}
          onPress={handlePhrase}
        />
      </SettingsListGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({});
