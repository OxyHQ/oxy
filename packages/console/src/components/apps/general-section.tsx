import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@oxyhq/services';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Delete02Icon, Image01Icon } from '@hugeicons/core-free-icons';
import { toast } from '@oxyhq/bloom/toast';
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
  const canEdit = access.can('app:update');
  const canDelete = access.can('app:delete');
  // Read off the permissions the SERVER serialises for this application, never
  // re-derived from a role name. `webhooks:*` is its own pair rather than a reuse
  // of `app:*`: the API derives it by containment from `apps:update`, so asking
  // for the specific right means this form follows the server if that ever
  // stops being true.
  const canReadWebhooks = access.can('webhooks:read');
  const canEditWebhooks = access.can('webhooks:update');
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
  const [webhookUrl, setWebhookUrl] = useState(application.webhookUrl ?? '');
  const [devWebhookUrl, setDevWebhookUrl] = useState(application.devWebhookUrl ?? '');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const nextScopes = mergePaymentsScopes(application.scopes, {
    read: paymentsRead,
    write: paymentsWrite,
  });

  // Only fields this caller may actually write count as dirty. A caller with
  // `app:update` but no `webhooks:update` sees the URLs disabled, so a webhook
  // difference could only ever come from a stale render — and enabling Save on
  // one would send a field the server drops.
  const webhooksDirty =
    canEditWebhooks &&
    (webhookUrl !== (application.webhookUrl ?? '') ||
      devWebhookUrl !== (application.devWebhookUrl ?? ''));

  const isDirty =
    name !== application.name ||
    description !== (application.description ?? '') ||
    websiteUrl !== (application.websiteUrl ?? '') ||
    privacyPolicyUrl !== (application.privacyPolicyUrl ?? '') ||
    termsUrl !== (application.termsUrl ?? '') ||
    icon !== (application.icon ?? '') ||
    !arraysEqual(redirectUris, application.redirectUris) ||
    !arraysEqual(nextScopes, application.scopes) ||
    webhooksDirty;

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
          // Sent only by a caller holding the right, and only as a trimmed
          // string. An empty string CLEARS the stored URL server-side, which is
          // the only way to turn delivery off — and for `webhookUrl` that also
          // discards the signing secret, since the server rotates it on every
          // change of the URL.
          ...(canEditWebhooks
            ? { webhookUrl: webhookUrl.trim(), devWebhookUrl: devWebhookUrl.trim() }
            : {}),
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

      {/*
        Webhook endpoints. Two URLs rather than one because the environments are
        separate everywhere else in this Console too — a staging deployment must
        not receive production events.

        The signing secret is deliberately NOT rendered: the API never serialises
        it, so there is nothing here to show, and it is replaced whenever the
        production URL changes. Saying so in the help text is the only way a
        developer can discover real server behaviour that would otherwise look
        like their receiver silently breaking.
      */}
      {canReadWebhooks && (
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Webhooks</h2>
            <p className="text-sm text-muted-foreground">
              Where Oxy delivers events for this application. Leave a field empty to stop
              delivery to that environment.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="app-webhook-url" className="text-sm">
              Production endpoint
            </Label>
            <Input
              id="app-webhook-url"
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://example.com/webhooks/oxy"
              disabled={!canEditWebhooks}
            />
            <p className="text-xs text-muted-foreground">
              Changing this URL generates a new signing secret and discards the old one. The
              secret is never shown again after that, so update your receiver in the same
              change.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="app-dev-webhook-url" className="text-sm">
              Development endpoint
            </Label>
            <Input
              id="app-dev-webhook-url"
              type="url"
              value={devWebhookUrl}
              onChange={(e) => setDevWebhookUrl(e.target.value)}
              placeholder="https://localhost:3000/webhooks/oxy"
              disabled={!canEditWebhooks}
            />
            <p className="text-xs text-muted-foreground">
              Used for development and staging deliveries. Changing it does not rotate the
              signing secret.
            </p>
          </div>
        </section>
      )}

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
