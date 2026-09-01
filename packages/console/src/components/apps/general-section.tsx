import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@oxyhq/services';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Delete02Icon, Image01Icon } from '@hugeicons/core-free-icons';
import { toast } from '@oxyhq/bloom';
import type {Application, CallerAccess} from '@/hooks/use-applications';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ImageUploadField } from '@/components/ui/image-upload-field';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { getErrorMessage } from '@/lib/api-error';
import { mergePaymentsScopes } from '@/lib/application-scopes';
import { stripSensitiveImageUrlQueryParams } from '@/lib/image-upload';
import {
  useDeleteApplication,
  useUpdateApplication,
} from '@/hooks/use-applications';

function arraysEqual(a: Array<string>, b: Array<string>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

interface GeneralSectionProps {
  application: Application;
  access: CallerAccess;
}

export function GeneralSection({ application, access }: GeneralSectionProps) {
  const navigate = useNavigate();
  const { oxyServices } = useAuth();
  const canEdit = access.can('apps:update');
  const canDelete = access.can('apps:delete');
  const updateApplication = useUpdateApplication();
  const deleteApplication = useDeleteApplication();

  const [name, setName] = useState(application.name);
  const [description, setDescription] = useState(application.description ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(application.websiteUrl ?? '');
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState(application.privacyPolicyUrl ?? '');
  const [termsUrl, setTermsUrl] = useState(application.termsUrl ?? '');
  const [icon, setIcon] = useState(application.icon ?? '');
  const [redirectUris, setRedirectUris] = useState<Array<string>>(application.redirectUris);
  const [newRedirectUri, setNewRedirectUri] = useState('');
  const [paymentsRead, setPaymentsRead] = useState(application.scopes.includes('payments:read'));
  const [paymentsWrite, setPaymentsWrite] = useState(application.scopes.includes('payments:write'));
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const nextScopes = mergePaymentsScopes(application.scopes, {
    read: paymentsRead,
    write: paymentsWrite,
  });

  const isDirty =
    name !== application.name ||
    description !== (application.description ?? '') ||
    websiteUrl !== (application.websiteUrl ?? '') ||
    privacyPolicyUrl !== (application.privacyPolicyUrl ?? '') ||
    termsUrl !== (application.termsUrl ?? '') ||
    icon !== (application.icon ?? '') ||
    !arraysEqual(redirectUris, application.redirectUris) ||
    !arraysEqual(nextScopes, application.scopes);

  const handleAddRedirectUri = () => {
    const value = newRedirectUri.trim();
    if (!value) {
      return;
    }
    if (redirectUris.includes(value)) {
      toast.error('That redirect URI is already in the list');
      return;
    }
    setRedirectUris([...redirectUris, value]);
    setNewRedirectUri('');
  };

  const handleRemoveRedirectUri = (uri: string) => {
    setRedirectUris(redirectUris.filter((item) => item !== uri));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }

    try {
      await updateApplication.mutateAsync({
        appId: application._id,
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
          websiteUrl: websiteUrl.trim() || undefined,
          // Empty string clears the stored legal URL server-side.
          privacyPolicyUrl: privacyPolicyUrl.trim(),
          termsUrl: termsUrl.trim(),
          // Empty string clears the logo. Strip credentials defensively before
          // saving because application metadata can be exposed publicly.
          icon: stripSensitiveImageUrlQueryParams(icon),
          redirectUris,
          scopes: nextScopes,
        },
      });
      toast.success('Application updated');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update application'));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteApplication.mutateAsync(application._id);
      setShowDeleteDialog(false);
      toast.success('Application deleted');
      navigate({ to: '/apps' });
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete application'));
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">General</h2>
          <p className="text-sm text-muted-foreground">Basic information about your application.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="app-name" className="text-sm">
            Name *
          </Label>
          <Input
            id="app-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Awesome App"
            maxLength={100}
            disabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="app-description" className="text-sm">
            Description
          </Label>
          <Textarea
            id="app-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A brief description of your application"
            rows={3}
            maxLength={500}
            disabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="app-website" className="text-sm">
            Website URL
          </Label>
          <Input
            id="app-website"
            type="url"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            placeholder="https://example.com"
            disabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="app-privacy-policy" className="text-sm">
            Privacy policy URL
          </Label>
          <Input
            id="app-privacy-policy"
            type="url"
            value={privacyPolicyUrl}
            onChange={(e) => setPrivacyPolicyUrl(e.target.value)}
            placeholder="https://example.com/privacy"
            disabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="app-terms" className="text-sm">
            Terms of service URL
          </Label>
          <Input
            id="app-terms"
            type="url"
            value={termsUrl}
            onChange={(e) => setTermsUrl(e.target.value)}
            placeholder="https://example.com/terms"
            disabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Logo</Label>
          <ImageUploadField
            oxyServices={oxyServices}
            value={icon}
            onChange={setIcon}
            disabled={!canEdit}
            label="Application logo"
            onError={(message) => toast.error(message)}
            fallback={
              application.name ? (
                <span className="text-lg font-semibold uppercase">
                  {application.name.charAt(0)}
                </span>
              ) : (
                <HugeiconsIcon icon={Image01Icon} size={24} />
              )
            }
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Redirect URIs</h2>
          <p className="text-sm text-muted-foreground">
            Exact-match allowlist for OAuth redirects. Add each URI your application uses.
          </p>
        </div>

        {redirectUris.length === 0 ? (
          <p className="text-sm text-muted-foreground">No redirect URIs configured.</p>
        ) : (
          <div className="space-y-2">
            {redirectUris.map((uri) => (
              <div
                key={uri}
                className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
              >
                <span className="text-sm font-mono text-foreground truncate">{uri}</span>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleRemoveRedirectUri(uri)}
                    aria-label="Remove redirect URI"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={14} className="text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {canEdit && (
          <div className="flex gap-2">
            <Input
              value={newRedirectUri}
              onChange={(e) => setNewRedirectUri(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddRedirectUri();
                }
              }}
              placeholder="https://example.com/callback"
              type="url"
            />
            <Button variant="outline" onClick={handleAddRedirectUri} disabled={!newRedirectUri.trim()}>
              <HugeiconsIcon icon={Add01Icon} size={14} className="mr-1.5" />
              Add
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Oxy Pay permissions</h2>
          <p className="text-sm text-muted-foreground">
            Grant payments scopes before creating a service credential for Oxy Pay integrations.
          </p>
        </div>
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">payments:read</p>
              <p className="text-xs text-muted-foreground">
                Read payment intents and webhook deliveries
              </p>
            </div>
            <Switch
              checked={paymentsRead}
              onCheckedChange={setPaymentsRead}
              disabled={!canEdit}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">payments:write</p>
              <p className="text-xs text-muted-foreground">Create and manage payment intents</p>
            </div>
            <Switch
              checked={paymentsWrite}
              onCheckedChange={setPaymentsWrite}
              disabled={!canEdit}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Application ID</h2>
          <p className="text-sm text-muted-foreground">Reference this application by its ID.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono text-foreground">{application._id}</span>
          <Badge variant={application.status === 'active' ? 'default' : 'secondary'}>
            {application.status === 'active' ? 'Active' : application.status}
          </Badge>
        </div>
      </section>

      {canEdit && (
        <div className="flex gap-3 border-t border-border pt-6">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateApplication.isPending || !isDirty || !name.trim()}
          >
            {updateApplication.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      )}

      {canDelete && (
        <section className="space-y-3 border-t border-border pt-6">
          <div>
            <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
            <p className="text-sm text-muted-foreground">
              Deleting an application removes all members and credentials. This cannot be undone.
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
            <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-1.5" />
            Delete application
          </Button>
        </section>
      )}

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete application</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{application.name}"? This removes all members,
              credentials, and usage data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteApplication.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteApplication.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
