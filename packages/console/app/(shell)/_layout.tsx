import { Slot } from 'expo-router';

import { ConsoleSettingsProvider } from '@/components/settings/ConsoleSettings';
import { ConsoleShell } from '@/components/shell/ConsoleShell';

export default function ShellLayout() {
  return (
    <ConsoleSettingsProvider>
      <ConsoleShell>
        <Slot />
      </ConsoleShell>
    </ConsoleSettingsProvider>
  );
}
