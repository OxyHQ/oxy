import * as Skeleton from '@oxy.so/bloom/skeleton';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { ApiState } from '@/components/loading/ApiState';
import { useConsoleOnboarding } from '@/hooks/use-console-onboarding';
import { deriveOnboardingStep } from '@/lib/onboarding';
import { UseCasesStep } from './UseCasesStep';
import { WelcomeStep } from './WelcomeStep';

/**
 * Holds the console behind the first-run welcome: terms until the current version is
 * accepted, then the use-case question, then the children. Nothing is stored locally; the
 * step is derived from the API state, so a new terms version asks everyone again. A failed
 * read shows a retry instead of blocking the console behind a blank screen.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { query } = useConsoleOnboarding();

  if (query.isError) {
    return (
      <View className="flex-1 justify-center bg-background p-6">
        <ApiState error={query.error} onRetry={() => void query.refetch()} />
      </View>
    );
  }
  if (!query.data) {
    return (
      <Skeleton.Region testID="onboarding-loading" className="flex-1 gap-4 bg-background p-10">
        <Skeleton.Box width="40%" height={32} borderRadius={8} />
        <Skeleton.Box width="60%" height={16} borderRadius={6} />
        <Skeleton.Box width="100%" height={160} borderRadius={12} />
      </Skeleton.Region>
    );
  }

  switch (deriveOnboardingStep(query.data)) {
    case 'terms':
      return <WelcomeStep />;
    case 'use-cases':
      return <UseCasesStep />;
    case 'done':
      return <>{children}</>;
  }
}
