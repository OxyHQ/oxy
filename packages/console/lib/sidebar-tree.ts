import type { SidebarIcon, SidebarTreeItem } from '@oxy.so/bloom/sidebar';
import type { ReactNode } from 'react';

/** The sub-pages of an application, in the order the detail screen's tabs show them. */
export const APP_TABS = [
  'general',
  'credentials',
  'roles',
  'webhooks',
  'usage',
  'inference',
  'store',
  'updates',
] as const;

export type AppTab = (typeof APP_TABS)[number];

/** Applications shown before "View all". */
export const APP_TREE_LIMIT = 8;

export const appHref = (appId: string, tab: AppTab = 'general'): string =>
  tab === 'general' ? `/apps/${appId}` : `/apps/${appId}/${tab}`;

/** Tree row keys: `app:<id>` for the application, `app:<id>:<tab>` for a sub-page. */
export const appTreeKey = (appId: string, tab?: AppTab): string =>
  tab ? `app:${appId}:${tab}` : `app:${appId}`;

/** The application a pathname is inside (`/apps/abc/usage` gives `abc`), if any. */
export function activeAppIdOf(pathname: string): string | undefined {
  const [first, appId] = pathname.split('/').filter(Boolean);
  return first === 'apps' && appId ? appId : undefined;
}

/** The tree row a pathname selects: the sub-page, `General` for the bare application route. */
export function selectedTreeKeyOf(pathname: string): string | undefined {
  const [, appId, tab] = pathname.split('/').filter(Boolean);
  if (!activeAppIdOf(pathname) || !appId) return undefined;
  const known = APP_TABS.find((candidate) => candidate === tab);
  return appTreeKey(appId, known ?? 'general');
}

/**
 * The primary row a pathname selects. Inside an application the tree row carries the
 * selection, so the section row ("Apps") stays unselected rather than lighting twice.
 */
export function selectedNavKeyOf(pathname: string, sectionOf: (path: string) => string) {
  return activeAppIdOf(pathname) ? undefined : sectionOf(pathname);
}

/** The first `limit` applications, plus the active one when it would fall past the cut. */
export function visibleApplications<A extends { _id: string }>(
  apps: ReadonlyArray<A>,
  limit: number,
  activeAppId?: string,
): { shown: Array<A>; hidden: number } {
  const shown = apps.slice(0, limit);
  const active = activeAppId ? apps.find((app) => app._id === activeAppId) : undefined;
  if (active && !shown.includes(active)) shown.push(active);
  return { shown, hidden: apps.length - shown.length };
}

export interface ApplicationRowOptions<A> {
  limit?: number;
  activeAppId?: string;
  /** Explicit disclosure state by application id; absent ids follow the active application. */
  open: Readonly<Record<string, boolean>>;
  onOpenChange: (appId: string, open: boolean) => void;
  tabLabel: (tab: AppTab) => string;
  tabIcon: (tab: AppTab) => SidebarIcon;
  leading: (app: A) => ReactNode;
  actions: (app: A) => ReactNode;
}

/** Applications as expandable rows (Notion pages), each holding its sub-pages. */
export function buildApplicationRows<A extends { _id: string; name: string }>(
  apps: ReadonlyArray<A>,
  options: ApplicationRowOptions<A>,
): { rows: Array<SidebarTreeItem>; hidden: number } {
  const { shown, hidden } = visibleApplications(
    apps,
    options.limit ?? APP_TREE_LIMIT,
    options.activeAppId,
  );
  const rows = shown.map<SidebarTreeItem>((app) => ({
    key: appTreeKey(app._id),
    label: app.name,
    href: appHref(app._id),
    leading: options.leading(app),
    actions: options.actions(app),
    actionsVisibility: 'hover',
    open: options.open[app._id] ?? app._id === options.activeAppId,
    onOpenChange: (next) => options.onOpenChange(app._id, next),
    items: APP_TABS.map<SidebarTreeItem>((tab) => ({
      key: appTreeKey(app._id, tab),
      label: options.tabLabel(tab),
      icon: options.tabIcon(tab),
      href: appHref(app._id, tab),
    })),
  }));
  return { rows, hidden };
}
