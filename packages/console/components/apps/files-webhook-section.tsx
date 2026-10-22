import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import type { Application } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { TextInputField } from './form-fields';
import { CopyValue, Notice, NoticeText, SectionBlock } from './primitives';

/**
 * Where Oxy tells this application about the files it uses (ADR 0043 D9):
 * `file.deleted`, `file.trashed`, `file.restored`, `file.visibility_changed`.
 *
 * A separate endpoint from the account-events webhook, set through
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
    <SectionBlock
      bordered
      title={t('applications.filesWebhook.title')}
      description={t('applications.filesWebhook.body')}
    >
      <TextInputField
        label={t('applications.filesWebhook.endpoint')}
        value={url}
        onChangeText={setUrl}
        placeholder="https://example.com/webhooks/oxy/files"
        keyboardType="url"
        disabled={!canEdit || pending}
        hint={`${status} ${t('applications.filesWebhook.challengeHint')}`}
      />

      {secret ? (
        <Notice type="warning" title={t('applications.filesWebhook.secretTitle')}>
          <NoticeText>{t('applications.filesWebhook.secretBody')}</NoticeText>
          <CopyValue
            value={secret}
            label={t('applications.filesWebhook.secretCopy')}
            copiedMessage={t('applications.filesWebhook.secretCopied')}
          />
        </Notice>
      ) : null}

      {canEdit ? (
        <View className="flex-row flex-wrap gap-3">
          <Button
            loading={pending}
            disabled={!url.trim().startsWith('https://')}
            onPress={() => void handleVerify()}
          >
            {t('applications.filesWebhook.verify')}
          </Button>
          {application.filesWebhookUrl ? (
            <Button appearance="outline" disabled={pending} onPress={() => void handleRemove()}>
              {t('applications.filesWebhook.stop')}
            </Button>
          ) : null}
        </View>
      ) : null}
    </SectionBlock>
  );
}
