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
import type { TranslateFn } from '@/lib/i18n';

/** A sidebar entry: `key` is the first path segment it owns, `href` where it goes. */
export interface ConsoleNavEntry {
  key: string;
  href: Href;
  labelKey: string;
  icon: SidebarNavItem['icon'];
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
  { key: 'documentation', href: '/documentation', labelKey: 'nav.documentation', icon: RiBookOpenLine },
  { key: 'settings', href: '/settings/account', labelKey: 'nav.settings', icon: RiSettings3Line },
];

export function buildSidebarItems(t: TranslateFn): Array<SidebarNavItem> {
  return CONSOLE_NAV.map((entry) => ({
    key: entry.key,
    label: t(entry.labelKey),
    icon: entry.icon,
  }));
}

/** First path segment of the current pathname, e.g. `/apps/abc` → `apps`. */
export function sectionOf(pathname: string): string {
  return pathname.split('/').filter(Boolean)[0] ?? 'dashboard';
}
