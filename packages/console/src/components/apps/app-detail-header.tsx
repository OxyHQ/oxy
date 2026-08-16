import { Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowLeft01Icon,
  RocketIcon,
  Settings01Icon,
  ShopSignIcon,
  SparklesIcon,
} from '@hugeicons/core-free-icons';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@oxyhq/services';
import { resolveStoredImageUrl } from '@/lib/image-upload';
import type { Application, CallerAccess } from '@/hooks/use-applications';

/** The top-level sections of an application. */
export type AppSection = 'settings' | 'inference' | 'store' | 'updates';

interface AppDetailHeaderProps {
  application: Application;
  access: CallerAccess;
  active: AppSection;
}

/**
 * Shared header for an application's detail pages: back link, identity, and the
 * top-level section navigation.
 *
 * Each section is offered only to callers holding the permission the API
 * enforces behind it, so nobody sees a tab that would only 403: `updates:manage`
 * for Updates, `app:read` for Store and for Inference — reading a routing policy
 * or a provider connection needs no more than reading the app, and each section
 * inside gates its own writes on `app:update`.
 */
export function AppDetailHeader({ application, access, active }: AppDetailHeaderProps) {
  const { oxyServices } = useAuth();
  const showInference = access.can('app:read');
  const showStore = access.can('app:read');
  const showUpdates = access.can('updates:manage');

  return (
    <div className="px-6 pt-6 border-b border-border">
      <Link
        to="/apps"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
        Back to applications
      </Link>
      <div className="flex items-center gap-3">
        <Avatar size="lg" className="rounded-lg after:rounded-lg">
          {application.icon && (
            <AvatarImage
              src={resolveStoredImageUrl(oxyServices, application.icon)}
              alt={application.name}
              className="rounded-lg"
            />
          )}
          <AvatarFallback className="rounded-lg text-lg uppercase">
            {application.name.charAt(0)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">{application.name}</h1>
          {application.description && (
            <p className="text-sm text-muted-foreground mt-1">{application.description}</p>
          )}
        </div>
      </div>

      <nav className="mt-6 flex items-center gap-1">
        <SectionTab
          to="/apps/$appId/settings"
          appId={application._id}
          icon={Settings01Icon}
          label="Settings"
          isActive={active === 'settings'}
        />
        {showInference && (
          <SectionTab
            to="/apps/$appId/inference"
            appId={application._id}
            icon={SparklesIcon}
            label="Inference"
            isActive={active === 'inference'}
          />
        )}
        {showStore && (
          <SectionTab
            to="/apps/$appId/store"
            appId={application._id}
            icon={ShopSignIcon}
            label="Store"
            isActive={active === 'store'}
          />
        )}
        {showUpdates && (
          <SectionTab
            to="/apps/$appId/updates"
            appId={application._id}
            icon={RocketIcon}
            label="Updates"
            isActive={active === 'updates'}
          />
        )}
      </nav>
    </div>
  );
}

interface SectionTabProps {
  to:
    | '/apps/$appId/settings'
    | '/apps/$appId/inference'
    | '/apps/$appId/store'
    | '/apps/$appId/updates';
  appId: string;
  icon: typeof Settings01Icon;
  label: string;
  isActive: boolean;
}

function SectionTab({ to, appId, icon, label, isActive }: SectionTabProps) {
  return (
    <Link
      to={to}
      params={{ appId }}
      className={cn(
        'flex items-center gap-1.5 border-b-2 px-2 pb-2.5 -mb-px text-sm font-medium transition-colors',
        isActive
          ? 'border-foreground text-foreground'
          : 'border-transparent text-foreground/60 hover:text-foreground'
      )}
    >
      <HugeiconsIcon icon={icon} size={16} />
      {label}
    </Link>
  );
}
