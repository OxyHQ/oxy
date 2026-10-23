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

import {
  type Application,
  type CallerAccess,
  useUpdateApplication,
} from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import {
  hasWebhookChanges,
  rotatesSigningSecret,
  storedWebhookEndpoints,
  type WebhookEndpointDraft,
  webhookPatch,
} from '@/lib/app-webhooks';
import { useTranslation } from '@/lib/i18n';

/**
 * The webhook endpoints (`webhookUrl`, `devWebhookUrl`).
 *
 * They are stored and editable (`PATCH /applications/:appId`) and NOTHING reads
 * them back yet: no Oxy service posts to them. The warning says so, because an
 * endpoint that silently never fires is indistinguishable from a receiver the
 * developer broke. `lib/app-webhooks.ts` decides what a save actually sends.
 */
export function WebhookEndpointsForm({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  // `webhooks:update` rather than `app:update`: the API derives it from
  // `apps:update` by containment, so asking for the specific right keeps this
  // form following the server if that stops being true.
  const canEdit = access.can('webhooks:update');
  const updateApplication = useUpdateApplication();
  const stored = storedWebhookEndpoints(application);
  const [draft, setDraft] = useState<WebhookEndpointDraft>(stored);

  // Derived, never synced in an effect: after a save the mutation patches the
  // cached application, `stored` becomes what was written, and the patch empties.
  const patch = webhookPatch(stored, draft, canEdit);

  const handleSave = async () => {
    try {
      await updateApplication.mutateAsync({ appId: application._id, data: patch });
      toast.success(t('applications.webhooks.saved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.webhooks.saveFailed')));
    }
  };

  return (
    <Card appearance="plain" border="thin">
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
          {/* Read from the patch about to be sent, so the warning cannot claim a
              rotation the request does not cause. Clearing the URL counts. */}
          {rotatesSigningSecret(patch) ? (
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
            disabled={!hasWebhookChanges(patch)}
            onPress={() => void handleSave()}
          >
            {t('applications.webhooks.save')}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
