import { BottomBar } from '@oxy.so/bloom/bottom-bar';
import { usePathname, useRouter } from 'expo-router';

import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { CONSOLE_NAV, SETTINGS_NAV, sectionOf } from '@/lib/navigation';
import { useTranslation } from '@/lib/i18n';

/** Mobile navigation: the first four sections plus Settings; the rest live in the drawer. */
export function ConsoleBottomBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { open: openSettings } = useConsoleSettings();
  const entries = CONSOLE_NAV.slice(0, 4);
  return (
    <BottomBar
      items={[
        ...entries.map((entry) => {
          const Icon = entry.icon;
          return { name: entry.key, label: t(entry.labelKey), icon: <Icon /> };
        }),
        { name: SETTINGS_NAV.key, label: t(SETTINGS_NAV.labelKey), icon: <SETTINGS_NAV.icon /> },
      ]}
      value={sectionOf(pathname)}
      onValueChange={(value) => {
        if (value === SETTINGS_NAV.key) {
          openSettings();
          return;
        }
        const entry = entries.find((candidate) => candidate.key === value);
        if (entry) router.navigate(entry.href);
      }}
    />
  );
}
