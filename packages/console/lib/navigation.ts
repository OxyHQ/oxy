import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiCpuLine } from '@oxy.so/bloom/icons/RiCpuLine';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiPlayCircleLine } from '@oxy.so/bloom/icons/RiPlayCircleLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import type { SidebarIcon } from '@oxy.so/bloom/sidebar';

import config from '@/lib/config';

/** A top-level section. `href` doubles as the sidebar item `key` and its first segment is the section. */
export interface ConsoleNavEntry {
  href: string;
  labelKey: string;
  icon: SidebarIcon;
  /** An off-site destination (opens outside the app); `href` then only keys the row. */
  external?: string;
}

/**
 * The console's top-level sections. Each area's routes live under `app/(shell)/<section>/`;
 * add a section here and a route folder, nothing else.
 */
export const CONSOLE_NAV: ReadonlyArray<ConsoleNavEntry> = [
  { href: '/dashboard', labelKey: 'nav.dashboard', icon: RiDashboardLine },
  { href: '/apps', labelKey: 'nav.apps', icon: RiKey2Line },
  { href: '/playground', labelKey: 'nav.playground', icon: RiPlayCircleLine },
  { href: '/usage', labelKey: 'nav.usage', icon: RiBarChartLine },
  { href: '/billing', labelKey: 'nav.billing', icon: RiBankCardLine },
  { href: '/models', labelKey: 'nav.models', icon: RiCpuLine },
  {
    href: '/documentation',
    labelKey: 'nav.documentation',
    icon: RiBookOpenLine,
    external: config.docsUrl,
  },
];

/** Sections the phone's bottom bar carries; the rest live in the drawer. */
export const BOTTOM_BAR_NAV = CONSOLE_NAV.slice(0, 4);

/** Settings is an action, not a route: it opens Bloom's settings modal. */
export const SETTINGS_NAV = {
  key: 'settings',
  labelKey: 'nav.settings',
  icon: RiSettings3Line,
} as const;

/** The `href` of the section a pathname belongs to, e.g. `/apps/abc` gives `/apps`. */
export function sectionOf(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0];
  return `/${first ?? 'dashboard'}`;
}
