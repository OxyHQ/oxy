import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ChartLineData02Icon,
  Key01Icon,
  Settings01Icon,
  WebhookIcon,
} from '@hugeicons/core-free-icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useApplication, useCallerAccess } from '@/hooks/use-applications';
import { AppDetailHeader } from '@/components/apps/app-detail-header';
import { GeneralSection } from '@/components/apps/general-section';
import { CredentialsSection } from '@/components/apps/credentials-section';
import { UsageSection } from '@/components/apps/usage-section';
import { WebhooksAuditSection } from '@/components/apps/webhooks-audit-section';

export const Route = createFileRoute('/_layout/apps/$appId/settings')({
  component: AppSettingsPage,
});

function AppSettingsPage() {
  const { appId } = Route.useParams();
  const { data: application, isLoading, isError } = useApplication(appId);
  // Access derives from the caller's membership in the application's OWNING
  // account, embedded on the application response as `callerMembership`. Members
  // are managed at the account level (see Account settings), not per-app.
  const access = useCallerAccess(application);

  if (isLoading) {
    return (
      <div className="flex-1 bg-background flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (isError || !application) {
    return (
      <div className="flex-1 bg-background flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">This application could not be loaded.</p>
        <Link to="/apps" className="text-sm text-foreground underline underline-offset-4">
          Back to applications
        </Link>
      </div>
    );
  }

  const showCredentialsTab = access.can('credentials:read');
  // `webhooks:read` answers to `apps:read` by containment on the account side,
  // so this is not the same tab as General with different fields — it is the
  // right the API enforces over the two endpoint columns, asked for by name.
  const showWebhooksTab = access.can('webhooks:read');
  const showUsageTab = access.can('usage:read');

  return (
    <ScrollArea className="flex-1 bg-background">
      <AppDetailHeader application={application} access={access} active="settings" />

      <div className="px-6 py-6">
        <Tabs defaultValue="general" className="gap-6">
          <TabsList variant="line">
            <TabsTrigger value="general">
              <HugeiconsIcon icon={Settings01Icon} size={16} />
              General
            </TabsTrigger>
            {showCredentialsTab && (
              <TabsTrigger value="credentials">
                <HugeiconsIcon icon={Key01Icon} size={16} />
                Credentials
              </TabsTrigger>
            )}
            {showWebhooksTab && (
              <TabsTrigger value="webhooks">
                <HugeiconsIcon icon={WebhookIcon} size={16} />
                Webhooks and audit
              </TabsTrigger>
            )}
            {showUsageTab && (
              <TabsTrigger value="usage">
                <HugeiconsIcon icon={ChartLineData02Icon} size={16} />
                Usage
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="general" className="max-w-2xl">
            <GeneralSection application={application} access={access} />
          </TabsContent>

          {showCredentialsTab && (
            <TabsContent value="credentials" className="max-w-3xl">
              <CredentialsSection application={application} access={access} />
            </TabsContent>
          )}

          {showWebhooksTab && (
            <TabsContent value="webhooks" className="max-w-2xl">
              {/*
                Keyed by application so navigating between two applications
                mounts a fresh draft instead of carrying the previous one's
                typing into a form that would then save it to the wrong app.
              */}
              <WebhooksAuditSection
                key={application._id}
                application={application}
                access={access}
              />
            </TabsContent>
          )}

          {showUsageTab && (
            <TabsContent value="usage" className="max-w-3xl">
              <UsageSection application={application} access={access} />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </ScrollArea>
  );
}
