import { AppShellPanel } from '@oxy.so/bloom/app-shell';
import { Slot } from 'expo-router';

/** Every page is one reading panel; the shell above owns the frame, sidebar and bars. */
export default function PagesLayout() {
  return (
    <AppShellPanel>
      <Slot />
    </AppShellPanel>
  );
}
