import { ScrollView, View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxy.so/services';

/**
 * Example authenticated screen (routed at `/demo`). It reads the signed-in Oxy
 * user from `useOxy()` — a starting point to replace with your own UI. For app
 * data, call your backend via `oxyServices.createLinkedClient({ baseURL })`.
 */
export default function DemoScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useOxy();

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 24, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
    >
      <Text className="text-2xl font-bold text-foreground mb-2">Demo</Text>
      <Text className="text-base text-muted-foreground mb-6">
        An example authenticated screen. Delete it, or build your app from here.
      </Text>

      <View className="rounded-2xl bg-card p-5 gap-1">
        <Text className="text-sm text-muted-foreground">Your Oxy user id</Text>
        <Text className="text-base font-semibold text-foreground">{user?.id ?? '—'}</Text>
      </View>
    </ScrollView>
  );
}
