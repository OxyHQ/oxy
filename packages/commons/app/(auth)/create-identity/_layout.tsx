import { Stack } from 'expo-router';

/**
 * Create Identity Flow Layout
 *
 * Stack navigator for the create identity flow steps. The order is:
 *   1. `index`           — runs createIdentity() (the key, locally; works
 *                          offline — nothing is registered yet)
 *   2. `recovery-phrase` — MUST be shown before anything else; gesture
 *                          back is disabled so users can't accidentally
 *                          skip writing down their phrase
 *   3. `interests`       — pick interest tags
 *   4. `username`        — pick a username; this registers the account, key
 *                          and username together (offline: on reconnect)
 *   5. `notifications`   — request push perms, finish onboarding
 */
export default function CreateIdentityLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen
        name="recovery-phrase"
        options={{
          // Disable the iOS swipe-back gesture so users can't accidentally
          // dismiss the screen before saving their phrase. The hardware
          // back button is also intercepted inside the screen itself.
          gestureEnabled: false,
        }}
      />
      <Stack.Screen name="interests" />
      <Stack.Screen name="username" />
      <Stack.Screen name="notifications" />
    </Stack>
  );
}

