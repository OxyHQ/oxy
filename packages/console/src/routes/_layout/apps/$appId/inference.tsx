import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ChartLineData02Icon,
  CloudIcon,
  Route01Icon,
  SparklesIcon,
  Target01Icon,
} from '@hugeicons/core-free-icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useApplication, useCallerAccess } from '@/hooks/use-applications';
import { AppDetailHeader } from '@/components/apps/app-detail-header';
import { InferenceOverviewSection } from '@/components/apps/inference-overview-section';
import { RoutingPolicySection } from '@/components/apps/routing-policy-section';
import { ProviderConnectionsSection } from '@/components/apps/provider-connections-section';
import { ApplicationUsageSpendSection } from '@/components/apps/application-usage-spend-section';
import { ApplicationBudgetsSection } from '@/components/apps/application-budgets-section';

/**
 * The application's inference configuration and its reporting: overview, routing
 * policy, BYOK, usage and spend, limits and budgets.
 *
 * A section of its own rather than more tabs under Settings, because these are
 * about how Oxy SERVES this application rather than about what the application
 * IS. Reaching it needs `app:read`, which is what the routes behind the
 * configuration tabs gate their reads on.
 *
 * The two reporting tabs take their own permissions, which is the API's split
 * rather than this page's: `usage:read` to see units, `billing:read` to see
 * money. Offering a tab to somebody the API would refuse turns a guaranteed 403
 * into an error after a click, so each is shown only to a caller holding the
 * right the endpoint behind it enforces.
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

  const showReporting = access.can('usage:read') || access.can('billing:read');
  const showBudgets = access.can('billing:read');

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
            {showReporting && (
              <TabsTrigger value="reporting">
                <HugeiconsIcon icon={ChartLineData02Icon} size={16} />
                Usage and spend
              </TabsTrigger>
            )}
            {showBudgets && (
              <TabsTrigger value="budgets">
                <HugeiconsIcon icon={Target01Icon} size={16} />
                Limits and budgets
              </TabsTrigger>
            )}
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

          {showReporting && (
            <TabsContent value="reporting" className="max-w-4xl">
              <ApplicationUsageSpendSection application={application} access={access} />
            </TabsContent>
          )}

          {showBudgets && (
            <TabsContent value="budgets" className="max-w-3xl">
              <ApplicationBudgetsSection application={application} access={access} />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </ScrollArea>
  );
}
