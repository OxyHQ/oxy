import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';

/**
 * "I have an Oxy account on the web": the account was made in an Oxy app with
 * an email. Linking it here gives it a key that lives on this phone, makes it
 * self-custodied, and deletes the email (ADR 0029 D3, ADR 0030). Security >
 * Link Commons, in Oxy Accounts or the account menu, shows the code this scans.
 */
export default function LinkAccountIntroScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.body}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('linkAccount.introTitle')}</Text>
        <Text style={[styles.text, { color: colors.text }]}>{t('linkAccount.introBody')}</Text>
      </View>
      <View style={styles.actions}>
        <Button appearance="solid" tone="accent" onPress={() => router.push('/(auth)/link-account/scan')} testID="link-account-scan">
          {t('linkAccount.scanAction')}
        </Button>
        <Button appearance="subtle" onPress={() => router.back()}>{t('common.back')}</Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between' },
  body: { gap: 12 },
  title: { fontSize: 28, fontWeight: '600' },
  text: { fontSize: 16, lineHeight: 24, opacity: 0.7 },
  actions: { gap: 12 },
});
