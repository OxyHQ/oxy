import { ActivityIndicator, View } from 'react-native';

export function SplashScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator />
    </View>
  );
}
