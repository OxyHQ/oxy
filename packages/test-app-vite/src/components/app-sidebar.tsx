import { HugeiconsIcon } from '@hugeicons/react';
import {
  UserIcon,
  UserAccountIcon,
  SmartPhone01Icon,
  Folder01Icon,
  UserMultiple02Icon,
  SecurityLockIcon,
} from '@hugeicons/core-free-icons';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

export type Page = 'auth' | 'profile' | 'sessions' | 'files' | 'social' | 'security';

const navItems: { page: Page; label: string; icon: typeof UserIcon }[] = [
  { page: 'auth', label: 'Authentication', icon: UserIcon },
  { page: 'profile', label: 'Profile', icon: UserAccountIcon },
  { page: 'sessions', label: 'Sessions & Devices', icon: SmartPhone01Icon },
  { page: 'files', label: 'Files & Assets', icon: Folder01Icon },
  { page: 'social', label: 'Social', icon: UserMultiple02Icon },
  { page: 'security', label: 'Security', icon: SecurityLockIcon },
];

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  activePage: Page;
  onNavigate: (page: Page) => void;
}

export function AppSidebar({ activePage, onNavigate, ...props }: AppSidebarProps) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-bold">
            O
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">OxyHQ SDK</span>
            <span className="text-xs text-muted-foreground">Developer Demo</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Features</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton
                    isActive={activePage === item.page}
                    onClick={() => onNavigate(item.page)}
                    tooltip={item.label}
                  >
                    <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
