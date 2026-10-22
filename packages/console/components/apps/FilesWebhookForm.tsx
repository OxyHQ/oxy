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
import { CodeBlock } from '@oxy.so/bloom/code';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import type { Application } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { copyText } from '@/lib/clipboard';
import { useTranslation } from '@/lib/i18n';

/**
 * Where Oxy tells this application about the files it uses (ADR 0043 D9):
 * `file.deleted`, `file.trashed`, `file.restored`, `file.visibility_changed`.
 *
 * A separate endpoint from the account-events webhook, set through
 * `PUT /applications/:appId/files-webhook`: Oxy stores it only after it echoed a
 * challenge, and every save issues a NEW signing secret that the API returns
 * once, so it is shown once here (component state only) and never again.
 */
export function FilesWebhookForm({
  application,
  canEdit,
}: {
  application: Application;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
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
      toast.success(t('applications.filesWebhook.verified'));
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.filesWebhook.verifyFailed')));
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
      toast.success(t('applications.filesWebhook.stopped'));
      await refresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.filesWebhook.removeFailed')));
    } finally {
      setPending(false);
    }
  };

  const status = application.filesWebhookVerifiedAt
    ? t('applications.filesWebhook.verifiedAt', {
        when: new Date(application.filesWebhookVerifiedAt).toLocaleString(),
      })
    : t('applications.filesWebhook.notSet');

  return (
    <Card appearance="outline">
      <CardHeader>
        <CardTitle>{t('applications.filesWebhook.title')}</CardTitle>
        <CardDescription>{t('applications.filesWebhook.body')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-4">
          <Field
            label={t('applications.filesWebhook.endpoint')}
            description={`${status} ${t('applications.filesWebhook.challengeHint')}`}
          >
            <TextFieldInput
              label={t('applications.filesWebhook.endpoint')}
              value={url}
              onChangeText={setUrl}
              placeholder="https://example.com/webhooks/oxy/files"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              disabled={!canEdit || pending}
            />
          </Field>
          {secret ? (
            <View className="gap-3">
              <Admonition type="warning">
                <Text variant="body-2-semibold">{t('applications.filesWebhook.secretTitle')}</Text>
                {'\n'}
                {t('applications.filesWebhook.secretBody')}
              </Admonition>
              <CodeBlock
                code={secret}
                filename={t('applications.filesWebhook.secretTitle')}
                lineNumbers={false}
                wrap
                onCopy={() => copyText(secret, t('applications.filesWebhook.secretCopied'))}
              />
              <View className="flex-row">
                <Button size="sm" appearance="outline" onPress={() => setSecret(null)}>
                  {t('applications.filesWebhook.secretDone')}
                </Button>
              </View>
            </View>
          ) : null}
        </View>
      </CardBody>
      {canEdit ? (
        <CardFooter>
          {application.filesWebhookUrl ? (
            <Button appearance="outline" disabled={pending} onPress={() => void handleRemove()}>
              {t('applications.filesWebhook.stop')}
            </Button>
          ) : null}
          <Button
            loading={pending}
            disabled={!url.trim().startsWith('https://')}
            onPress={() => void handleVerify()}
          >
            {t('applications.filesWebhook.verify')}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
