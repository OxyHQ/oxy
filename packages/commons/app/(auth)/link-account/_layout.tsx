import { Stack } from 'expo-router';

/**
 * Linking an Oxy account made on the web to Commons (ADR 0029 D3): the intro,
 * the scan of the other screen's code, the confirmation, and `resume`, where an
 * onboarding interrupted mid-link comes back to.
 */
export default function LinkAccountLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="scan" />
      <Stack.Screen name="confirm" />
      <Stack.Screen name="resume" />
    </Stack>
  );
}
