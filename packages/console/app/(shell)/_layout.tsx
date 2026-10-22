import { Slot } from 'expo-router';

import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { ConsoleSettingsProvider } from '@/components/settings/ConsoleSettings';
import { ConsoleShell } from '@/components/shell/ConsoleShell';

export default function ShellLayout() {
  return (
    <OnboardingGate>
      <ConsoleSettingsProvider>
        <ConsoleShell>
          <Slot />
        </ConsoleShell>
      </ConsoleSettingsProvider>
    </OnboardingGate>
  );
}
