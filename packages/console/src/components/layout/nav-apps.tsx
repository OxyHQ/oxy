import { Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  MoreHorizontalSquare01Icon,
  Package01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useApplications } from '@/hooks/use-applications';
import { useAuth } from '@oxy.so/services';
import { resolveStoredImageUrl } from '@/lib/image-upload';

export function NavApps() {
  const { isMobile } = useSidebar();
  const { oxyServices } = useAuth();
  const { data: applications = [] } = useApplications();

  if (applications.length === 0) {
    return null;
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Your Apps</SidebarGroupLabel>
      <SidebarMenu>
        {applications.slice(0, 5).map((app) => (
          <SidebarMenuItem key={app._id}>
            <SidebarMenuButton asChild>
              <Link to="/apps/$appId/settings" params={{ appId: app._id }}>
                {app.icon ? (
                  <img
                    src={resolveStoredImageUrl(oxyServices, app.icon)}
                    alt=""
                    className="size-4 shrink-0 rounded-sm object-cover"
                  />
                ) : (
                  <HugeiconsIcon icon={Package01Icon} size={16} />
                )}
                <span>{app.name}</span>
              </Link>
            </SidebarMenuButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction showOnHover>
                  <HugeiconsIcon icon={MoreHorizontalSquare01Icon} size={16} />
                  <span className="sr-only">More</span>
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-48 rounded-lg"
                side={isMobile ? 'bottom' : 'right'}
                align={isMobile ? 'end' : 'start'}
              >
                <DropdownMenuItem asChild>
                  <Link to="/apps/$appId/settings" params={{ appId: app._id }}>
                    <HugeiconsIcon
                      icon={Settings01Icon}
                      size={14}
                      className="text-muted-foreground"
                    />
                    <span>Open</span>
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        ))}
        {applications.length > 5 && (
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="text-sidebar-foreground/70">
              <Link to="/apps">
                <HugeiconsIcon
                  icon={MoreHorizontalSquare01Icon}
                  size={16}
                  className="text-sidebar-foreground/70"
                />
                <span>View all ({applications.length})</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
