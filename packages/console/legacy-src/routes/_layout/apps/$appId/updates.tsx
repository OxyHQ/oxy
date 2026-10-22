import { Link, createFileRoute } from '@tanstack/react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useApplication, useCallerAccess } from '@/hooks/use-applications';
import { AppDetailHeader } from '@/components/apps/app-detail-header';
import { UpdatesSection } from '@/components/apps/updates-section';

export const Route = createFileRoute('/_layout/apps/$appId/updates')({
  component: AppUpdatesPage,
});

function AppUpdatesPage() {
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
      <AppDetailHeader application={application} access={access} active="updates" />

      <div className="px-6 py-6">
        <div className="max-w-4xl">
          <UpdatesSection application={application} access={access} />
        </div>
      </div>
    </ScrollArea>
  );
}
