import type { CommandItem } from '@oxy.so/bloom/command';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBuilding2Line } from '@oxy.so/bloom/icons/RiBuilding2Line';

import type { TranslateFn } from '@/lib/i18n';
import { CONSOLE_NAV, SETTINGS_NAV } from '@/lib/navigation';

export interface CommandMenuActions {
  navigate: (href: string) => void;
  openExternal: (url: string) => void;
  openSettings: () => void;
  createWorkspace: () => void;
  /** Whether the signed-in account is staff with the claims capability. */
  isStaff?: boolean;
}

/**
 * The palette's items: a few actions, then every sidebar section and Settings. Pure, so it is testable without rendering.
 */
export function buildCommandItems(
  t: TranslateFn,
  { navigate, openExternal, openSettings, createWorkspace, isStaff = false }: CommandMenuActions,
): Array<CommandItem> {
  const group = (key: 'actions' | 'navigation') => t(`commandMenu.groups.${key}`);
  return [
    {
      id: 'create-app',
      label: t('commandMenu.createApp'),
      icon: RiAddLine,
      group: group('actions'),
      keywords: ['new', 'application', 'create'],
      onSelect: () => navigate('/apps'),
    },
    {
      id: 'create-workspace',
      label: t('settingsPage.switcher.create'),
      icon: RiBuilding2Line,
      group: group('actions'),
      keywords: ['new', 'organization', 'account'],
      onSelect: createWorkspace,
    },
    ...CONSOLE_NAV.filter((entry) => !entry.staff || isStaff).map((entry) => ({
      id: `nav:${entry.href}`,
      label: t(entry.labelKey),
      icon: entry.icon as CommandItem['icon'],
      group: group('navigation'),
      onSelect: () => (entry.external ? openExternal(entry.external) : navigate(entry.href)),
    })),
    {
      id: `nav:${SETTINGS_NAV.key}`,
      label: t(SETTINGS_NAV.labelKey),
      icon: SETTINGS_NAV.icon as CommandItem['icon'],
      group: group('navigation'),
      onSelect: openSettings,
    },
  ];
}
