import { Stack } from 'expo-router';

/**
 * Import Identity Flow Layout
 * 
 * Stack navigator for the import identity flow steps
 */
export default function ImportIdentityLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="restore-from-backup" />
      <Stack.Screen name="private-key" />
      <Stack.Screen name="username" />
      <Stack.Screen name="notifications" />
    </Stack>
  );
}

