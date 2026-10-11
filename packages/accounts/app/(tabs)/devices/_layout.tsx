import { Stack } from 'expo-router';
import { useTranslation } from '@/lib/i18n';

export default function DevicesLayout() {
  const { t } = useTranslation();
  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="[deviceId]"
        options={{
          presentation: 'modal',
          title: t('devices.detail.title'),
          headerShown: false,
        }}
      />
    </Stack>
  );
}
