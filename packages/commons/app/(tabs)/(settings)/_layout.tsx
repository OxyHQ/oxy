import React from 'react';
import { Stack } from 'expo-router';
import { ErrorFallback } from '@/components/error-fallback';

/**
 * Settings tab stack: the management menu (`index`) plus the identity/vault
 * management detail screens it pushes — about your identity, encrypted backup,
 * proof of personhood, verifiable credentials, account deletion, and the
 * Peable wallets of the organizations the person runs (ADR 0061). Screens
 * self-render their headers/back affordances.
 */
export default function SettingsTabLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="about-identity" />
      <Stack.Screen name="backup-recovery" />
      <Stack.Screen name="create-backup" />
      <Stack.Screen name="rotate-key" />
      <Stack.Screen name="previous-keys" />
      <Stack.Screen name="recovery-phrase" />
      <Stack.Screen name="personhood" />
      <Stack.Screen name="credentials/index" />
      <Stack.Screen name="credentials/[recordId]" />
      <Stack.Screen name="node" />
      <Stack.Screen name="delete-account" />
      <Stack.Screen name="organization-wallets/index" />
      <Stack.Screen name="organization-wallets/[accountId]" />
      <Stack.Screen name="organization-wallets/create" options={{ gestureEnabled: false }} />
      <Stack.Screen name="organization-wallets/add" />
      <Stack.Screen name="organization-wallets/phrase" />
    </Stack>
  );
}

export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}
