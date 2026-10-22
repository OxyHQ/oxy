/** Deep-link compatibility: opens the settings modal on a page, then returns to the dashboard. */
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { type ConsoleSettingsPage, useConsoleSettings } from './ConsoleSettings';

export function SettingsLink({ page }: { page?: ConsoleSettingsPage }) {
  const { open } = useConsoleSettings();
  const router = useRouter();
  useEffect(() => {
    open(page);
    router.replace('/');
  }, [open, page, router]);
  return null;
}
