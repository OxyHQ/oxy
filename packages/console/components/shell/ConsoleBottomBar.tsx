import { BottomBar } from '@oxy.so/bloom/bottom-bar';
import { usePathname, useRouter } from 'expo-router';

import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { useTranslation } from '@/lib/i18n';
import { BOTTOM_BAR_NAV, SETTINGS_NAV, sectionOf } from '@/lib/navigation';

/**
 * Phone navigation: the first four sections plus Settings (which opens the modal); the rest
 * live in the drawer. `AppShell` pins it, pads for the home indicator and reserves its space.
 */
export function ConsoleBottomBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { open: openSettings } = useConsoleSettings();
  const section = sectionOf(pathname);

  return (
    <BottomBar
      items={[
        ...BOTTOM_BAR_NAV.map((entry) => {
          const Icon = entry.icon;
          return { name: entry.href, label: t(entry.labelKey), icon: <Icon /> };
        }),
        { name: SETTINGS_NAV.key, label: t(SETTINGS_NAV.labelKey), icon: <SETTINGS_NAV.icon /> },
      ]}
      // Settings is an action, never the selected section: the page behind stays highlighted.
      value={BOTTOM_BAR_NAV.some((entry) => entry.href === section) ? section : ''}
      onValueChange={(value) => {
        if (value === SETTINGS_NAV.key) {
          openSettings();
          return;
        }
        router.navigate(value as never);
      }}
    />
  );
}
