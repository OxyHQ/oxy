import { BottomBar } from '@oxy.so/bloom/bottom-bar';
import { usePathname, useRouter } from 'expo-router';

import { CONSOLE_NAV, sectionOf } from '@/lib/navigation';
import { useTranslation } from '@/lib/i18n';

/** Mobile navigation: the first four sections; the rest live in the drawer. */
export function ConsoleBottomBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const entries = CONSOLE_NAV.slice(0, 4);
  return (
    <BottomBar
      items={entries.map((entry) => {
        const Icon = entry.icon;
        return { name: entry.key, label: t(entry.labelKey), icon: <Icon /> };
      })}
      value={sectionOf(pathname)}
      onValueChange={(value) => {
        const entry = entries.find((candidate) => candidate.key === value);
        if (entry) router.navigate(entry.href);
      }}
    />
  );
}
