import { Slot } from 'expo-router';

import { ConsoleShell } from '@/components/shell/ConsoleShell';

export default function ShellLayout() {
  return (
    <ConsoleShell>
      <Slot />
    </ConsoleShell>
  );
}
