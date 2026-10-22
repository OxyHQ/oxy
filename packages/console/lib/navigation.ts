import type { SidebarNavItem } from '@oxy.so/bloom/sidebar';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiCpuLine } from '@oxy.so/bloom/icons/RiCpuLine';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiPlayCircleLine } from '@oxy.so/bloom/icons/RiPlayCircleLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';

import type { Href } from 'expo-router';

import config from '@/lib/config';
import type { TranslateFn } from '@/lib/i18n';

/** A sidebar entry: `key` is the first path segment it owns, `href` where it goes. */
export interface ConsoleNavEntry {
  key: string;
  href: Href;
  labelKey: string;
  icon: SidebarNavItem['icon'];
  /** An off-site destination (opens in a new tab); `href` is then unused. */
  external?: string;
}

/**
 * The console's top-level sections. Each area's routes live under
 * `app/(shell)/<key>/`; add a section here and a route folder, nothing else.
 */
export const CONSOLE_NAV: ReadonlyArray<ConsoleNavEntry> = [
  { key: 'dashboard', href: '/dashboard', labelKey: 'nav.dashboard', icon: RiDashboardLine },
  { key: 'apps', href: '/apps', labelKey: 'nav.apps', icon: RiKey2Line },
  { key: 'playground', href: '/playground', labelKey: 'nav.playground', icon: RiPlayCircleLine },
  { key: 'usage', href: '/usage', labelKey: 'nav.usage', icon: RiBarChartLine },
  { key: 'billing', href: '/billing', labelKey: 'nav.billing', icon: RiBankCardLine },
  { key: 'models', href: '/models', labelKey: 'nav.models', icon: RiCpuLine },
  {
    key: 'documentation',
    href: '/dashboard',
    labelKey: 'nav.documentation',
    icon: RiBookOpenLine,
    external: config.docsUrl,
  },
];

/** Settings is an action, not a route: it opens Bloom's settings modal. */
export const SETTINGS_NAV = {
  key: 'settings',
  labelKey: 'nav.settings',
  icon: RiSettings3Line,
} as const;

/** Rows pinned to the bottom of the sidebar. */
export function buildSecondaryItems(
  t: TranslateFn,
  openSettings: () => void,
): Array<SidebarNavItem> {
  return [
    {
      key: SETTINGS_NAV.key,
      label: t(SETTINGS_NAV.labelKey),
      icon: SETTINGS_NAV.icon,
      onPress: openSettings,
    },
  ];
}

export function buildSidebarItems(
  t: TranslateFn,
  openExternal: (url: string) => void,
): Array<SidebarNavItem> {
  return CONSOLE_NAV.map((entry) => {
    const external = entry.external;
    return {
      key: entry.key,
      label: t(entry.labelKey),
      icon: entry.icon,
      // `href` makes a real anchor on web and routes through `onNavigate`; an
      // off-site row is an action instead.
      ...(external ? { onPress: () => openExternal(external) } : { href: String(entry.href) }),
    };
  });
}

/** First path segment of the current pathname, e.g. `/apps/abc` → `apps`. */
export function sectionOf(pathname: string): string {
  return pathname.split('/').filter(Boolean)[0] ?? 'dashboard';
}
