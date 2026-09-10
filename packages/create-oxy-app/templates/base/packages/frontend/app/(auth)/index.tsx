import { View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OxySignInButton } from '@oxy.so/services';
import { useTranslation } from '@/lib/i18n';

export default function SignInScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-1 items-center justify-center bg-background px-6"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="w-full max-w-sm items-center gap-3">
        <Text className="text-2xl font-semibold text-foreground text-center">{t('auth.title')}</Text>
        <Text className="text-base text-muted-foreground text-center mb-4">{t('auth.subtitle')}</Text>
        {/* Opens the in-app OxyAccountDialog (account switcher + "Sign in with
            Oxy" + password). No redirect to an external IdP. */}
        <OxySignInButton variant="contained" />
      </View>
    </View>
  );
}
