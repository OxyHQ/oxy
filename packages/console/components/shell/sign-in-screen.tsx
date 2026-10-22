import { Button } from '@oxy.so/bloom/button';
import { Text, View } from 'react-native';

import { useTranslation } from '@/lib/i18n';

export function SignInScreen({ onSignIn }: { onSignIn: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
      <Text className="text-2xl font-semibold text-foreground">{t('app.title')}</Text>
      <Button onPress={onSignIn}>{t('common.signIn')}</Button>
    </View>
  );
}
