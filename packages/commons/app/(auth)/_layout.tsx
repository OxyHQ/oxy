import { Stack } from 'expo-router';
import { AuthFlowProvider } from '@/contexts/auth-flow-context';
import { ErrorFallback } from '@/components/error-fallback';

/**
 * Auth Layout
 *
 * Layout for the Commons onboarding flow (welcome, create-identity,
 * import-identity, link-account). Commons is a NATIVE-ONLY app (iOS/Android) — there is no
 * web build and no web sign-in, because the key vault never leaves the device.
 */
export default function AuthLayout() {
    return (
        <AuthFlowProvider>
            <Stack
                screenOptions={{
                    headerShown: false,
                }}
            >
                <Stack.Screen name="index" />
                <Stack.Screen name="welcome" />
                <Stack.Screen name="create-identity" />
                <Stack.Screen name="import-identity" />
                <Stack.Screen name="link-account" />
                <Stack.Screen name="recover-identity" />
            </Stack>
        </AuthFlowProvider>
    );
}

/**
 * Route-level error boundary for the auth flow. Captures render errors
 * inside `(auth)` so a crash during identity creation/import doesn't
 * leave the user stuck on a white screen.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
    return <ErrorFallback {...props} />;
}

