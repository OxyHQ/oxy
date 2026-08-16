import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { CloudIcon, Route01Icon, SparklesIcon } from '@hugeicons/core-free-icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useApplication, useCallerAccess } from '@/hooks/use-applications';
import { AppDetailHeader } from '@/components/apps/app-detail-header';
import { InferenceOverviewSection } from '@/components/apps/inference-overview-section';
import { RoutingPolicySection } from '@/components/apps/routing-policy-section';
import { ProviderConnectionsSection } from '@/components/apps/provider-connections-section';

/**
 * The application's inference configuration: overview, routing policy, BYOK.
 *
 * A section of its own rather than three more tabs under Settings, because these
 * are configuration of how Oxy SERVES this application rather than of what the
 * application IS. Reaching it needs `app:read`, which is what the routes behind
 * every tab gate their reads on.
 */
export const Route = createFileRoute('/_layout/apps/$appId/inference')({
  component: AppInferencePage,
});

function AppInferencePage() {
  const { appId } = Route.useParams();
  const { data: application, isLoading, isError } = useApplication(appId);
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

  return (
    <ScrollArea className="flex-1 bg-background">
      <AppDetailHeader application={application} access={access} active="inference" />

      <div className="px-6 py-6">
        <Tabs defaultValue="overview" className="gap-6">
          <TabsList variant="line">
            <TabsTrigger value="overview">
              <HugeiconsIcon icon={SparklesIcon} size={16} />
              Overview
            </TabsTrigger>
            <TabsTrigger value="routing">
              <HugeiconsIcon icon={Route01Icon} size={16} />
              Routing policy
            </TabsTrigger>
            <TabsTrigger value="byok">
              <HugeiconsIcon icon={CloudIcon} size={16} />
              Provider connections
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="max-w-3xl">
            <InferenceOverviewSection application={application} access={access} />
          </TabsContent>

          <TabsContent value="routing" className="max-w-3xl">
            <RoutingPolicySection application={application} access={access} />
          </TabsContent>

          <TabsContent value="byok" className="max-w-3xl">
            <ProviderConnectionsSection application={application} access={access} />
          </TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
  );
}
