import type { CommandItem } from '@oxy.so/bloom/command';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiPlayLine } from '@oxy.so/bloom/icons/RiPlayLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import type { Href } from 'expo-router';
import { Linking } from 'react-native';

import type { TranslateFn } from '@/lib/i18n';
import { CONSOLE_NAV } from '@/lib/navigation';

/** Sections reachable from the palette that the sidebar does not list. */
const EXTRA_DESTINATIONS: ReadonlyArray<{
  id: string;
  href: Href;
  labelKey: string;
  icon: CommandItem['icon'];
}> = [
  { id: 'playground', href: '/playground', labelKey: 'nav.playground', icon: RiPlayLine },
  { id: 'clarity', href: '/clarity', labelKey: 'commandMenu.clarity', icon: RiSearchLine },
];

/**
 * The palette's items: a few actions, then every sidebar section, then the
 * sections the sidebar leaves out. Pure, so it is testable without rendering.
 */
export function buildCommandItems(
  t: TranslateFn,
  navigate: (href: Href) => void,
): Array<CommandItem> {
  const actions: Array<CommandItem> = [
    {
      id: 'create-app',
      label: t('commandMenu.createApp'),
      icon: RiAddLine,
      group: t('commandMenu.groups.actions'),
      keywords: ['new', 'application', 'create'],
      onSelect: () => navigate('/apps'),
    },
  ];

  const navigation: Array<CommandItem> = [
    ...CONSOLE_NAV.map((entry) => ({
      id: `nav-${entry.key}`,
      label: t(entry.labelKey),
      icon: entry.icon as CommandItem['icon'],
      group: t('commandMenu.groups.navigation'),
      onSelect: () =>
        entry.external ? void Linking.openURL(entry.external) : navigate(entry.href),
    })),
    ...EXTRA_DESTINATIONS.map((entry) => ({
      id: `nav-${entry.id}`,
      label: t(entry.labelKey),
      icon: entry.icon,
      group: t('commandMenu.groups.navigation'),
      onSelect: () => navigate(entry.href),
    })),
  ];

  return [...actions, ...navigation];
}
