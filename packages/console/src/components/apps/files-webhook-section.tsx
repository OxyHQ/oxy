import { useState } from 'react';
import { useAuth } from '@oxy.so/services';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxy.so/bloom/toast';
import type { Application } from '@/hooks/use-applications';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from '@/lib/api-error';

/**
 * Where Oxy tells this application about the files it uses (ADR 0042 D9):
 * `file.deleted`, `file.trashed`, `file.restored`, `file.visibility_changed`.
 *
 * A separate endpoint from the account-events webhook above, set through
 * `PUT /applications/:appId/files-webhook`: Oxy stores it only after it echoed
 * a challenge, and every save issues a NEW signing secret that the API returns
 * once — so this section shows it once, right after saving, and never again.
 */
export function FilesWebhookSection({
  application,
  canEdit,
}: {
  application: Application;
  canEdit: boolean;
}) {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(application.filesWebhookUrl ?? '');
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['application', application._id] });

  const handleVerify = async () => {
    setPending(true);
    try {
      const result = await oxyServices.apps.setFilesWebhook(application._id, url.trim());
      setSecret(result.secret);
      toast.success('File events endpoint verified');
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error, 'The endpoint could not be verified'));
    } finally {
      setPending(false);
    }
  };

  const handleRemove = async () => {
    setPending(true);
    try {
      await oxyServices.apps.removeFilesWebhook(application._id);
      setSecret(null);
      setUrl('');
      toast.success('File events stopped');
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to remove the endpoint'));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-4 border-t border-border pt-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">File events</h2>
        <p className="text-sm text-muted-foreground">
          Oxy tells this endpoint when a file your application uses or owns is deleted, moved to
          trash, restored, or changes visibility, so you can stop showing it. Requests are JSON,
          signed with HMAC-SHA256 in the <code>oxy-signature</code> header; verify them with{' '}
          <code>verifyFileEventSignature</code> from <code>@oxy.so/core/server</code>.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="app-files-webhook-url" className="text-sm">
          Endpoint
        </Label>
        <Input
          id="app-files-webhook-url"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/webhooks/oxy/files"
          disabled={!canEdit || pending}
        />
        <p className="text-xs text-muted-foreground">
          {application.filesWebhookVerifiedAt
            ? `Verified ${new Date(application.filesWebhookVerifiedAt).toLocaleString()}.`
            : 'Not set.'}{' '}
          Saving sends <code>{'{"type":"webhook.challenge","challenge":"…"}'}</code>; answer with{' '}
          <code>{'{"challenge":"…"}'}</code>. Every save issues a new signing secret.
        </p>
      </div>

      {secret && (
        <Alert>
          <AlertTitle>Signing secret — shown once</AlertTitle>
          <AlertDescription>
            <p>Store it now; Oxy never shows it again. Events already queued are signed with it.</p>
            <Input readOnly value={secret} className="mt-2 font-mono" />
          </AlertDescription>
        </Alert>
      )}

      {canEdit && (
        <div className="flex gap-3">
          <Button
            size="sm"
            onClick={() => void handleVerify()}
            disabled={pending || !url.trim().startsWith('https://')}
          >
            {pending ? 'Verifying...' : 'Verify and save'}
          </Button>
          {application.filesWebhookUrl && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleRemove()}
              disabled={pending}
            >
              Stop file events
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
