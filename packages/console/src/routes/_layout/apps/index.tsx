import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  Package01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import { toast } from '@oxyhq/bloom/toast';
import { useAuth } from '@oxyhq/services';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useApplications, useCreateApplication } from '@/hooks/use-applications';
import { useAccount } from '@/hooks/use-account';
import { resolveStoredImageUrl } from '@/lib/image-upload';

export const Route = createFileRoute('/_layout/apps/')({
  component: AppsPage,
});

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function AppsPage() {
  const navigate = useNavigate();
  const { oxyServices } = useAuth();
  const { currentAccount, canCreateApplications } = useAccount();
  const { data: applications = [], isLoading } = useApplications();
  const createApplicationMutation = useCreateApplication();

  // Creating an application is `apps:create` on the ACTIVE account, read from
  // the server's own permission list on `callerMembership` rather than inferred
  // from the role name — the server is the only authority on the role map, and
  // a per-member revoke can withdraw the permission without changing the role.
  const canCreate = currentAccount ? canCreateApplications(currentAccount) : false;

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');

  const handleCreateApplication = async () => {
    if (!name.trim()) {
      toast.error('Please enter an application name');
      return;
    }

    try {
      const newApp = await createApplicationMutation.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        websiteUrl: websiteUrl.trim() || undefined,
      });
      setShowCreateDialog(false);
      setName('');
      setDescription('');
      setWebsiteUrl('');
      toast.success('Application created');
      navigate({ to: '/apps/$appId/settings', params: { appId: newApp._id } });
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create application'));
    }
  };

  const handleCopyAppId = (appId: string) => {
    navigator.clipboard.writeText(appId);
    toast.success('Application ID copied to clipboard');
  };

  const handleOpenCreate = () => {
    setName('');
    setDescription('');
    setWebsiteUrl('');
    setShowCreateDialog(true);
  };

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Applications</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Applications you own or collaborate on
            </p>
          </div>
          {canCreate && (
            <Button size="sm" onClick={handleOpenCreate}>
              <HugeiconsIcon icon={Add01Icon} size={16} className="mr-2" />
              Create application
            </Button>
          )}
        </div>
      </div>

      {/* Applications List */}
      <div className="px-6">
        {isLoading ? (
          <div className="py-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="py-4 border-b border-border">
                <Skeleton.Box width={128} height={16} style={{ marginBottom: 8 }} />
                <Skeleton.Box width={192} height={12} />
              </div>
            ))}
          </div>
        ) : applications.length === 0 ? (
          <div className="py-12 text-center">
            <HugeiconsIcon
              icon={Package01Icon}
              size={48}
              className="text-muted-foreground mx-auto mb-4"
            />
            <p className="text-sm font-medium text-foreground mb-1">No applications yet</p>
            <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
              {canCreate
                ? 'Create your first application to manage members, credentials, and usage.'
                : 'This account has no applications, and your membership does not include permission to create one. An owner or admin can grant it.'}
            </p>
            {canCreate && (
              <Button size="sm" onClick={handleOpenCreate}>
                <HugeiconsIcon icon={Add01Icon} size={16} className="mr-2" />
                Create your first application
              </Button>
            )}
          </div>
        ) : (
          <div>
            {applications.map((app, index) => (
              <ContextMenu key={app._id}>
                <ContextMenuTrigger asChild>
                  <Link
                    to="/apps/$appId/settings"
                    params={{ appId: app._id }}
                    className={`flex items-center justify-between py-4 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors ${
                      index < applications.length - 1
                        ? 'border-b border-border mx-0 px-0 rounded-none hover:bg-transparent hover:opacity-70'
                        : ''
                    }`}
                  >
                    <div className="flex flex-1 items-start gap-3">
                      <Avatar size="default" className="mt-0.5 rounded-lg after:rounded-lg">
                        {app.icon && (
                          <AvatarImage
                            src={resolveStoredImageUrl(oxyServices, app.icon)}
                            alt={app.name}
                            className="rounded-lg"
                          />
                        )}
                        <AvatarFallback className="rounded-lg uppercase">
                          {app.name.charAt(0)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{app.name}</p>
                          <Badge
                            variant={app.status === 'active' ? 'default' : 'secondary'}
                            className="text-xs"
                          >
                            {app.status === 'active' ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        {app.description && (
                          <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">
                            {app.description}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          Created {new Date(app.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      size={16}
                      className="text-muted-foreground ml-4"
                    />
                  </Link>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      navigate({ to: '/apps/$appId/settings', params: { appId: app._id } });
                    }}
                  >
                    <HugeiconsIcon icon={Settings01Icon} className="mr-2 size-4" />
                    Open
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      handleCopyAppId(app._id);
                    }}
                  >
                    <HugeiconsIcon icon={Copy01Icon} className="mr-2 size-4" />
                    Copy application ID
                    <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        )}
      </div>

      {/* Create Application Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create application</DialogTitle>
            <DialogDescription>
              Create a new application to manage members, credentials, and usage.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm">
                Name *
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Awesome App"
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description" className="text-sm">
                Description
              </Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of your application"
                rows={3}
                maxLength={500}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="websiteUrl" className="text-sm">
                Website URL
              </Label>
              <Input
                id="websiteUrl"
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://example.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateApplication}
              disabled={createApplicationMutation.isPending || !name.trim()}
            >
              {createApplicationMutation.isPending ? 'Creating...' : 'Create application'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}
