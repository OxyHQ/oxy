import { Slot } from 'expo-router';

import { ConsoleSettingsProvider } from '@/components/settings/ConsoleSettings';
import { ConsoleShell } from '@/components/shell/ConsoleShell';

// The first-run welcome (`components/onboarding/OnboardingGate`) is built and tested but
// switched off until `GET /console/onboarding` is live on api.oxy.so: until then the API
// answers 404 and the gate would hold the whole console. Wrap this tree in
// `<OnboardingGate>` again once the endpoint is deployed.
export default function ShellLayout() {
  return (
    <ConsoleSettingsProvider>
      <ConsoleShell>
        <Slot />
      </ConsoleShell>
    </ConsoleSettingsProvider>
  );
}
