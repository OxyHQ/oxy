import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from '@oxyhq/bloom/toast';
import type { WebhookEndpointDraft } from '@/lib/app-webhooks';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AuditRefusal } from '@/components/audit/audit-refusal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from '@/lib/api-error';
import {
  hasWebhookChanges,
  rotatesSigningSecret,
  storedWebhookEndpoints,
  webhookPatch,
} from '@/lib/app-webhooks';
import { useUpdateApplication } from '@/hooks/use-applications';

/**
 * This application's webhook endpoints, its signing secret and its audit events
 * (issue #972, "webhooks/audit events where applicable").
 *
 * A section of its own rather than three fields inside General, because the
 * endpoints, the secret's behaviour, the state of event delivery and where an
 * application's trail can be read are one subject that needs explaining
 * together — and because General had grown to carry every unrelated field an
 * application has. The endpoint fields are MOVED here, not copied: two forms
 * writing the same two columns would each report success while overwriting the
 * other.
 *
 * ## What is true today, and said on the screen rather than only here
 *
 * MEASURED against `packages/api`: `webhookUrl` and `devWebhookUrl` are stored
 * and editable (`PATCH /applications/:appId`), and NOTHING reads them back. The
 * only webhook dispatch in the API is `assetService.notifyLinks`, which delivers
 * to a per-file-link URL and never touches an application's. So a developer who
 * registers a receiver here is configuring something that is not yet called, and
 * the alert below says so — an endpoint that silently never fires is
 * indistinguishable from a receiver the developer broke.
 *
 * ## The signing secret is never rendered, and cannot be
 *
 * `applications.webhook_secret` is regenerated server-side on every change to
 * the production URL and is serialised by no endpoint, on create or on rotate —
 * `serializeApplication` omits it and `routes/auth.ts` explicitly refuses to
 * select the column. There is therefore nothing to reveal here, no "show once"
 * dialog and no copy button: this section states where the secret comes from and
 * that it cannot be read back, which is the only thing a Console can honestly
 * offer about it.
 *
 * ## Audit events: what exists is named, and no aggregate is invented
 *
 * The whole application surface has exactly ONE audit read,
 * `GET /applications/:appId/credentials/:credId/audit` — per credential, `limit`
 * only, no cursor. There is no application-scoped trail, and
 * `GET /accounts/:id/audit` cannot be narrowed to one application either: its
 * query schema is `.strict()` over `limit` and `cursor` alone. Merging the
 * per-credential reads here would produce "the newest events of each
 * credential", which reads as this application's history and is not it, and
 * would be a second definition of an order that lives in SQL. So the section
 * names where the real trails are instead, and refuses rather than showing an
 * empty one to a caller without `credentials:read`.
 */
export function WebhooksAuditSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  // `webhooks:update` rather than `app:update`: the API derives it from
  // `apps:update` by containment (`utils/accountRoles.ts`), so asking for the
  // specific right means this form follows the server if that stops being true.
  const canEdit = access.can('webhooks:update');
  // The permission behind the credential audit read, asked for by the name the
  // API enforces — not `webhooks:read`, which gates the endpoints above.
  const canReadAudit = access.can('credentials:read');
  const updateApplication = useUpdateApplication();

  const stored = storedWebhookEndpoints(application);
  const [draft, setDraft] = useState<WebhookEndpointDraft>(stored);

  // Derived, never synced in an effect: after a save the mutation patches the
  // cached application, `stored` becomes the values just written, and the patch
  // below empties out on its own. The call site keys this component by
  // application id, so navigating to another application mounts a fresh draft
  // rather than carrying this one's typing across.
  const patch = webhookPatch(stored, draft, canEdit);
  const isDirty = hasWebhookChanges(patch);
  const willRotateSecret = rotatesSigningSecret(patch);

  const handleSave = async () => {
    try {
      await updateApplication.mutateAsync({ appId: application._id, data: patch });
      toast.success('Webhook endpoints updated');
    } catch (error) {
      // The route validates both fields as an absolute URL or the empty string,
      // and rejects the whole patch otherwise. The server's own message is more
      // useful than a client-side restatement of its rule.
      toast.error(getErrorMessage(error, 'Failed to update webhook endpoints'));
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Where Oxy would deliver events for this application. Leave a field empty to stop
            delivery to that environment.
          </p>
        </div>

        <Alert>
          <AlertTitle>Oxy does not deliver application events yet</AlertTitle>
          <AlertDescription>
            These endpoints are stored configuration: no Oxy service posts to them today, so a
            receiver registered here will not be called until event delivery ships. Saving one now
            is safe — it records where deliveries should go — but do not debug a receiver against
            it, because silence is expected rather than a fault at your end.
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label htmlFor="app-webhook-url" className="text-sm">
            Production endpoint
          </Label>
          <Input
            id="app-webhook-url"
            type="url"
            value={draft.webhookUrl}
            onChange={(event) => setDraft({ ...draft, webhookUrl: event.target.value })}
            placeholder="https://example.com/webhooks/oxy"
            disabled={!canEdit}
          />
          <p className="text-xs text-muted-foreground">
            An absolute URL, or empty to stop production delivery. Changing it replaces this
            application's signing secret.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="app-dev-webhook-url" className="text-sm">
            Development endpoint
          </Label>
          <Input
            id="app-dev-webhook-url"
            type="url"
            value={draft.devWebhookUrl}
            onChange={(event) => setDraft({ ...draft, devWebhookUrl: event.target.value })}
            placeholder="https://localhost:3000/webhooks/oxy"
            disabled={!canEdit}
          />
          <p className="text-xs text-muted-foreground">
            Used for development and staging deliveries. Changing it rotates nothing.
          </p>
        </div>

        {/*
          Shown from the patch that is about to be sent, so the warning cannot
          claim a rotation the request does not cause — or stay silent about one
          it does. Clearing the production URL counts: the server discards the
          secret along with the URL.
        */}
        {willRotateSecret && (
          <Alert>
            <AlertTitle>Saving replaces the signing secret</AlertTitle>
            <AlertDescription>
              The production endpoint changed, so Oxy will generate a new signing secret for this
              application and discard the current one. Neither is ever shown, here or in any API
              response.
            </AlertDescription>
          </Alert>
        )}

        {canEdit && (
          <div className="flex gap-3 border-t border-border pt-6">
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={!isDirty || updateApplication.isPending}
            >
              {updateApplication.isPending ? 'Saving...' : 'Save endpoints'}
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Signing secret</h2>
          <p className="text-sm text-muted-foreground">
            How a delivery from Oxy will be verifiable, once deliveries exist.
          </p>
        </div>
        <div className="rounded-lg border border-border px-4 py-3 space-y-2">
          <p className="text-sm text-foreground">
            {application.webhookUrl
              ? 'A signing secret exists for this application.'
              : 'This application has no signing secret.'}
          </p>
          <p className="text-sm text-muted-foreground">
            {application.webhookUrl
              ? 'It was generated when the production endpoint was last set or changed. It is stored by Oxy and returned by no endpoint, so it cannot be shown here, copied, or rotated on its own — changing the production URL is what replaces it.'
              : 'One is generated when a production endpoint is set, and replaced whenever that URL changes. It is returned by no endpoint, so it can never be shown here or copied.'}
          </p>
        </div>
      </section>

      {/*
        Audit events.

        A refusal rather than an empty list when the caller may not read them:
        `GET /applications/:appId/credentials/:credId/audit` is gated on
        `credentials:read`, and a trail rendered as "nothing has happened" to
        somebody who is simply not allowed to see it is the one failure an audit
        surface must not have.
      */}
      <section className="space-y-3 border-t border-border pt-6">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Audit events</h2>
          <p className="text-sm text-muted-foreground">
            What has changed about this application, and who did it.
          </p>
        </div>
        {canReadAudit ? (
          <Alert>
            <AlertTitle>This application's trail is read per credential</AlertTitle>
            <AlertDescription>
              <p>
                Every audit event an application has is a credential event — created, rotated,
                revoked, and every bearer that resolved to one of its credentials and was still
                refused. The API serves them one credential at a time, so each credential's own
                trail is under the <span className="text-foreground">Credentials</span> tab of this
                page, expanded from the credential it belongs to.
              </p>
              <p>
                There is no application-wide trail endpoint, and this page does not assemble one by
                merging the per-credential reads: each is capped independently and carries no
                cursor, so a merged list would show the newest events of each credential rather than
                the newest events of this application — complete-looking and not complete. The
                nearest real aggregate is the account trail at{' '}
                <Link to="/settings/audit">Settings → Audit log</Link>, which is computed
                server-side in one order and covers every application on this account.
              </p>
            </AlertDescription>
          </Alert>
        ) : (
          <AuditRefusal missing={['credentials:read']} what="this application's audit events" />
        )}
      </section>
    </div>
  );
}
