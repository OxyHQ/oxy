import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiBrain01Icon,
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
    title: 'API Keys',
    url: '/apps',
    icon: Key01Icon,
  },
  {
    title: 'Usage',
    url: '/usage',
    icon: ChartLineData01Icon,
  },
  {
    title: 'Billing',
    url: '/billing',
    icon: Money01Icon,
  },
];

const resourceNavItems = [
  {
    title: 'Models',
    url: '/models',
    icon: AiBrain01Icon,
  },
  {
    title: 'Documentation',
    url: config.docsUrl,
    icon: Doc01Icon,
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
      { title: 'Account', url: '/settings/account' },
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
  return <ProfileButton expanded={isMobile || state === 'expanded'} />;
}
