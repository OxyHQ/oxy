import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useUpdateApplication } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import {
  hasWebhookChanges,
  rotatesSigningSecret,
  storedWebhookEndpoints,
  type WebhookEndpointDraft,
  webhookPatch,
} from '@/lib/app-webhooks';
import { useTranslation } from '@/lib/i18n';
import { AuditRefusal } from './audit-refusal';
import { FilesWebhookSection } from './files-webhook-section';
import { TextInputField } from './form-fields';
import { Notice, NoticeText, SectionBlock } from './primitives';

/**
 * This application's webhook endpoints, its signing secret and its audit events
 * (issue #972, "webhooks/audit events where applicable").
 *
 * ## What is true today, and said on the screen rather than only here
 *
 * `webhookUrl` and `devWebhookUrl` are stored and editable
 * (`PATCH /applications/:appId`), and NOTHING reads them back: no Oxy service
 * posts to them yet. The notice below says so — an endpoint that silently never
 * fires is indistinguishable from a receiver the developer broke.
 *
 * ## The signing secret is never rendered, and cannot be
 *
 * `applications.webhook_secret` is regenerated server-side on every change to
 * the production URL and is serialised by no endpoint, so there is nothing to
 * reveal: this section states where the secret comes from and that it cannot be
 * read back.
 *
 * ## Audit events: what exists is named, and no aggregate is invented
 *
 * The only application audit read is per credential
 * (`GET /applications/:appId/credentials/:credId/audit`), gated on
 * `credentials:read`. Merging per-credential reads here would show "the newest
 * events of each credential" as if it were this application's history, so the
 * section points at the real trails instead, and refuses — rather than showing
 * an empty list — to a caller without `credentials:read`.
 */
export function WebhooksAuditSection({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  // `webhooks:update` rather than `app:update`: the API derives it from
  // `apps:update` by containment, so asking for the specific right means this
  // form follows the server if that stops being true.
  const canEdit = access.can('webhooks:update');
  // The permission behind the credential audit read, by the name the API enforces.
  const canReadAudit = access.can('credentials:read');
  const updateApplication = useUpdateApplication();

  const stored = storedWebhookEndpoints(application);
  const [draft, setDraft] = useState<WebhookEndpointDraft>(stored);

  // Derived, never synced in an effect: after a save the mutation patches the
  // cached application, `stored` becomes the values just written, and the patch
  // empties out on its own. The route keys this component by application id.
  const patch = webhookPatch(stored, draft, canEdit);
  const isDirty = hasWebhookChanges(patch);
  const willRotateSecret = rotatesSigningSecret(patch);

  const handleSave = async () => {
    try {
      await updateApplication.mutateAsync({ appId: application._id, data: patch });
      toast.success(t('applications.webhooks.saved'));
    } catch (error) {
      // The server's own message is more useful than a client-side restatement
      // of its rule (absolute URL or the empty string).
      toast.error(getErrorMessage(error, t('applications.webhooks.saveFailed')));
    }
  };

  return (
    <View className="gap-8">
      <SectionBlock
        title={t('applications.webhooks.title')}
        description={t('applications.webhooks.subtitle')}
      >
        <Notice type="warning" title={t('applications.webhooks.notDeliveredTitle')}>
          <NoticeText>{t('applications.webhooks.notDeliveredBody')}</NoticeText>
        </Notice>

        <TextInputField
          label={t('applications.webhooks.production')}
          value={draft.webhookUrl}
          onChangeText={(webhookUrl) => setDraft({ ...draft, webhookUrl })}
          placeholder="https://example.com/webhooks/oxy"
          keyboardType="url"
          disabled={!canEdit}
          hint={t('applications.webhooks.productionHint')}
        />
        <TextInputField
          label={t('applications.webhooks.development')}
          value={draft.devWebhookUrl}
          onChangeText={(devWebhookUrl) => setDraft({ ...draft, devWebhookUrl })}
          placeholder="https://localhost:3000/webhooks/oxy"
          keyboardType="url"
          disabled={!canEdit}
          hint={t('applications.webhooks.developmentHint')}
        />

        {/* Shown from the patch about to be sent, so the warning cannot claim a
            rotation the request does not cause. Clearing the production URL counts. */}
        {willRotateSecret ? (
          <Notice type="warning" title={t('applications.webhooks.rotateTitle')}>
            <NoticeText>{t('applications.webhooks.rotateBody')}</NoticeText>
          </Notice>
        ) : null}

        {canEdit ? (
          <View className="flex-row gap-3 border-t border-border pt-6">
            <Button
              loading={updateApplication.isPending}
              disabled={!isDirty}
              onPress={() => void handleSave()}
            >
              {t('applications.webhooks.save')}
            </Button>
          </View>
        ) : null}
      </SectionBlock>

      <FilesWebhookSection application={application} canEdit={canEdit} />

      <SectionBlock
        bordered
        title={t('applications.webhooks.secretTitle')}
        description={t('applications.webhooks.secretSubtitle')}
      >
        <View className="gap-2 rounded-lg border border-border px-4 py-3">
          <Text className="text-sm text-foreground">
            {application.webhookUrl
              ? t('applications.webhooks.secretExists')
              : t('applications.webhooks.secretNone')}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {application.webhookUrl
              ? t('applications.webhooks.secretExistsBody')
              : t('applications.webhooks.secretNoneBody')}
          </Text>
        </View>
      </SectionBlock>

      {/* A refusal rather than an empty list when the caller may not read the
          trail: a trail shown as "nothing has happened" to somebody who is simply
          not allowed to see it is the one failure an audit surface must not have. */}
      <SectionBlock
        bordered
        title={t('applications.webhooks.auditTitle')}
        description={t('applications.webhooks.auditSubtitle')}
      >
        {canReadAudit ? (
          <Notice type="info" title={t('applications.webhooks.auditPerCredentialTitle')}>
            <NoticeText>{t('applications.webhooks.auditPerCredentialBody')}</NoticeText>
            <NoticeText>
              {t('applications.webhooks.auditNoAggregate')}{' '}
              <Link href="/settings/audit" className="text-foreground underline">
                {t('applications.webhooks.auditAccountLink')}
              </Link>
              .
            </NoticeText>
          </Notice>
        ) : (
          <AuditRefusal
            missing={['credentials:read']}
            what={t('applications.webhooks.auditWhat')}
          />
        )}
      </SectionBlock>
    </View>
  );
}
