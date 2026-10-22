import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import {
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';

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
import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { useTranslation } from '@/lib/i18n';
import { AuditRefusal } from './audit-refusal';
import { FilesWebhookSection } from './files-webhook-section';

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
  const { open: openSettings } = useConsoleSettings();
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
    <View className="gap-6">
      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.webhooks.title')}</CardTitle>
          <CardDescription>{t('applications.webhooks.subtitle')}</CardDescription>
        </CardHeader>
        <CardBody>
          <View className="gap-4">
            <Admonition type="warning">
              <Text variant="body-2-semibold">{t('applications.webhooks.notDeliveredTitle')}</Text>
              {'\n'}
              {t('applications.webhooks.notDeliveredBody')}
            </Admonition>

            <Field
              label={t('applications.webhooks.production')}
              description={t('applications.webhooks.productionHint')}
            >
              <TextFieldInput
                label={t('applications.webhooks.production')}
                value={draft.webhookUrl}
                onChangeText={(webhookUrl) => setDraft({ ...draft, webhookUrl })}
                placeholder="https://example.com/webhooks/oxy"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={!canEdit}
              />
            </Field>
            <Field
              label={t('applications.webhooks.development')}
              description={t('applications.webhooks.developmentHint')}
            >
              <TextFieldInput
                label={t('applications.webhooks.development')}
                value={draft.devWebhookUrl}
                onChangeText={(devWebhookUrl) => setDraft({ ...draft, devWebhookUrl })}
                placeholder="https://localhost:3000/webhooks/oxy"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                disabled={!canEdit}
              />
            </Field>

            {/* Shown from the patch about to be sent, so the warning cannot claim a
                rotation the request does not cause. Clearing the production URL counts. */}
            {willRotateSecret ? (
              <Admonition type="warning">
                <Text variant="body-2-semibold">{t('applications.webhooks.rotateTitle')}</Text>
                {'\n'}
                {t('applications.webhooks.rotateBody')}
              </Admonition>
            ) : null}
          </View>
        </CardBody>
        {canEdit ? (
          <CardFooter>
            <Button
              loading={updateApplication.isPending}
              disabled={!isDirty}
              onPress={() => void handleSave()}
            >
              {t('applications.webhooks.save')}
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <FilesWebhookSection application={application} canEdit={canEdit} />

      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.webhooks.secretTitle')}</CardTitle>
          <CardDescription>{t('applications.webhooks.secretSubtitle')}</CardDescription>
        </CardHeader>
        <CardBody>
          <Admonition type="info">
            <Text variant="body-2-semibold">
              {application.webhookUrl
                ? t('applications.webhooks.secretExists')
                : t('applications.webhooks.secretNone')}
            </Text>
            {'\n'}
            {application.webhookUrl
              ? t('applications.webhooks.secretExistsBody')
              : t('applications.webhooks.secretNoneBody')}
          </Admonition>
        </CardBody>
      </Card>

      {/* A refusal rather than an empty list when the caller may not read the
          trail: a trail shown as "nothing has happened" to somebody who is simply
          not allowed to see it is the one failure an audit surface must not have. */}
      <Card appearance="outline">
        <CardHeader>
          <CardTitle>{t('applications.webhooks.auditTitle')}</CardTitle>
          <CardDescription>{t('applications.webhooks.auditSubtitle')}</CardDescription>
        </CardHeader>
        <CardBody>
          {canReadAudit ? (
            <Admonition type="info">
              <Text variant="body-2-semibold">
                {t('applications.webhooks.auditPerCredentialTitle')}
              </Text>
              {'\n'}
              {t('applications.webhooks.auditPerCredentialBody')}
              {'\n'}
              {t('applications.webhooks.auditNoAggregate')}{' '}
              <Text
                role="link"
                className="text-foreground underline"
                onPress={() => openSettings('audit')}
              >
                {t('applications.webhooks.auditAccountLink')}
              </Text>
              .
            </Admonition>
          ) : (
            <AuditRefusal
              missing={['credentials:read']}
              what={t('applications.webhooks.auditWhat')}
            />
          )}
        </CardBody>
      </Card>
    </View>
  );
}
