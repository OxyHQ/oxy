import { Stack } from 'expo-router';
import { ErrorFallback } from '@/components/error-fallback';

/**
 * Auth Layout
 *
 * Accounts is a management-only app — identity CREATION lives in the Commons
 * app. The `(auth)` group is therefore sign-in ONLY: a single `index` route
 * that authenticates the user (password / "Sign in with Oxy" handoff) against
 * an account whose keys live in Commons. There is no welcome, create-identity,
 * or import-identity flow here.
 */
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}

/**
 * Route-level error boundary for the auth flow. Captures render errors
 * inside `(auth)` so a crash during sign-in doesn't leave the user stuck on a
 * white screen.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}
