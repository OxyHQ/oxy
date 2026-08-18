import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiBrain01Icon,
  Book02Icon,
  ChartLineData01Icon,
  CommandIcon,
  Doc01Icon,
  Home09Icon,
  Key01Icon,
  Login01Icon,
  Money01Icon,
  Settings01Icon,
  SourceCodeIcon,
} from '@hugeicons/core-free-icons';
import { ProfileButton, useAuth } from '@oxyhq/services';
import { NavMain } from './nav-main';
import { NavApps } from './nav-apps';
import { SidebarHeaderBrand } from './sidebar-header';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import config from '@/lib/config';

const mainNavItems = [
  {
    title: 'Dashboard',
    url: '/dashboard',
    icon: Home09Icon,
  },
  {
    title: 'Playground',
    url: '/playground',
    icon: CommandIcon,
  },
  {
    title: 'Applications',
    url: '/apps',
    icon: Key01Icon,
  },
  {
    title: 'Usage',
    url: '/usage',
    icon: ChartLineData01Icon,
  },
  /*
   * Billing is a group rather than a page because its sections answer different
   * questions from different tables, and the sidebar is the first place that
   * distinction shows: Spend and Holds and charges read the financial ledger,
   * while Usage — deliberately a sibling of Billing rather than a child of it —
   * reads telemetry. Plans and credits is a third thing again: a product
   * subscription, in credits rather than money.
   *
   * Every entry below resolves to a route backed by a live endpoint
   * (`/inference/reporting/*` and `/billing/accounts/*`), so none of them lands
   * on an empty page.
   */
  {
    title: 'Billing',
    url: '/billing',
    icon: Money01Icon,
    items: [
      { title: 'Overview', url: '/billing' },
      { title: 'Spend', url: '/billing/spend' },
      { title: 'Holds and charges', url: '/billing/charges' },
      { title: 'Budgets', url: '/billing/budgets' },
      { title: 'Plans and credits', url: '/billing/plans' },
      { title: 'Change history', url: '/billing/audit' },
    ],
  },
];

const resourceNavItems = [
  {
    title: 'Models',
    url: '/models',
    icon: AiBrain01Icon,
  },
  /*
   * The in-app documentation pages existed and were reachable only by typing
   * their URL — nothing in the shell linked to them, while the sidebar's
   * "Documentation" pointed off-site. The epic asks for Documentation and SDKs
   * as navigation, so the group points at the in-app pages, which are real; the
   * developer site keeps its own entry rather than being dropped.
   */
  {
    title: 'Documentation',
    url: '/documentation',
    icon: Doc01Icon,
    items: [
      { title: 'Quick start', url: '/documentation/quickstart' },
      { title: 'Authentication', url: '/documentation/authentication' },
      { title: 'Chat completions', url: '/documentation/chat-completions' },
      { title: 'Models', url: '/documentation/models' },
      { title: 'SDKs', url: '/documentation/sdks' },
    ],
  },
  {
    title: 'Developer site',
    url: config.docsUrl,
    icon: Book02Icon,
    external: true,
  },
  {
    title: 'Examples',
    url: '/examples',
    icon: SourceCodeIcon,
  },
];

const settingsNavItems = [
  {
    title: 'Settings',
    url: '/settings',
    icon: Settings01Icon,
    items: [
      // Members are managed at the account level, on the same screen — the epic
      // names "Members/account settings" as one item, and it is one page.
      { title: 'Account and members', url: '/settings/account' },
      /*
       * The audit log sits under Settings rather than beside Applications
       * because it is account-wide: it spans every application's credentials
       * AND the account's provider connections, which no single application
       * page can show. Money changes have their own trail under Billing, on the
       * same principle that keeps units and money on different screens.
       */
      { title: 'Audit log', url: '/settings/audit' },
    ],
  },
];

export function AppSidebar() {
  const { isAuthenticated, signIn } = useAuth();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarHeaderBrand />
      </SidebarHeader>

      <SidebarContent>
        <NavMain items={mainNavItems} label="Platform" />
        <NavApps />
        <NavMain items={resourceNavItems} label="Resources" />
        <NavMain items={settingsNavItems} label="Settings" />
      </SidebarContent>

      <SidebarFooter>
        {isAuthenticated ? (
          <SidebarProfileButton />
        ) : (
          <Button variant="ghost" className="w-full justify-start gap-2 px-2" onClick={() => signIn()}>
            <HugeiconsIcon icon={Login01Icon} size={18} />
            <span>Sign in</span>
          </Button>
        )}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function SidebarProfileButton() {
  const { isMobile, state } = useSidebar();
  return (
    <ProfileButton
      expanded={isMobile || state === 'expanded'}
      onNavigateManage={() => {
        window.open(config.accountsUrl, '_blank', 'noopener,noreferrer');
      }}
    />
  );
}
