import { Stack } from 'expo-router';

/**
 * Linking an Oxy account made on the web to Commons (ADR 0029 D3): the intro,
 * the scan of auth.oxy.so's code, and the confirmation.
 */
export default function LinkAccountLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="scan" />
      <Stack.Screen name="confirm" />
    </Stack>
  );
}
