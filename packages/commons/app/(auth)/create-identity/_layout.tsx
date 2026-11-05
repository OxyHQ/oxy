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
 *   3. `username`        — pick a username; this registers the account, key
 *                          and username together (offline: on reconnect)
 *   4. `/enable-notifications` (a root route, see that file) — request push
 *      permission, finish onboarding
 *
 * There is no interests step: what it collected was never stored (the Oxy
 * account has no field for a person's interests), so asking was a promise the
 * app did not keep.
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
      <Stack.Screen name="username" />
    </Stack>
  );
}
