import { View, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxy.so/services';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useTranslation } from '@/lib/i18n';

export default function HomeScreen() {
  const { t } = useTranslation();
  const { user, logout } = useOxy();
  const insets = useSafeAreaInsets();

  const handle = (user && getNormalizedUserHandle(user)) || '';
  const displayName = user?.name?.displayName?.trim() || handle;

  return (
    <View
      className="flex-1 bg-background px-6"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom }}
    >
      <View className="flex-1 gap-2">
        <Text className="text-3xl font-bold text-foreground">{t('home.title')}</Text>
        <Text className="text-base text-muted-foreground">{t('home.subtitle')}</Text>

        {user ? (
          <View className="mt-8 rounded-2xl bg-card p-5">
            <Text className="text-sm text-muted-foreground">{t('home.signedInAs')}</Text>
            <Text className="text-lg font-semibold text-foreground">{displayName}</Text>
            {handle ? <Text className="text-sm text-muted-foreground">@{handle}</Text> : null}
          </View>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => logout()}
        className="mb-4 items-center rounded-2xl bg-primary px-5 py-3 active:opacity-80"
      >
        <Text className="font-semibold text-primary-foreground">Sign out</Text>
      </Pressable>
    </View>
  );
}
