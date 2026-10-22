import { Dialog } from '@oxy.so/bloom/dialog';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useCreateApplication } from '@/hooks/use-applications';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { TextAreaField, TextInputField } from './form-fields';

/** Creates an application and lands on its detail page. */
export function CreateApplicationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const createApplication = useCreateApplication();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');

  const close = () => {
    setName('');
    setDescription('');
    setWebsiteUrl('');
    onClose();
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error(t('applications.create.nameRequired'));
      return;
    }
    try {
      const created = await createApplication.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        websiteUrl: websiteUrl.trim() || undefined,
      });
      close();
      toast.success(t('applications.create.created'));
      router.push(`/apps/${created._id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, t('applications.create.failed')));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('applications.create.title')}
      description={t('applications.create.body')}
      actions={[
        { label: t('common.cancel'), color: 'cancel', disabled: createApplication.isPending },
        {
          label: t('applications.create.submit'),
          onPress: () => void handleCreate(),
          disabled: !name.trim(),
          loading: createApplication.isPending,
          shouldCloseOnPress: false,
        },
      ]}
      testID="create-application-dialog"
    >
      <View className="gap-4">
        <TextInputField
          label={t('applications.fields.name')}
          value={name}
          onChangeText={setName}
          placeholder={t('applications.fields.namePlaceholder')}
          maxLength={100}
          autoCapitalize="sentences"
        />
        <TextAreaField
          label={t('applications.fields.description')}
          value={description}
          onChangeText={setDescription}
          placeholder={t('applications.fields.descriptionPlaceholder')}
          maxLength={500}
        />
        <TextInputField
          label={t('applications.fields.websiteUrl')}
          value={websiteUrl}
          onChangeText={setWebsiteUrl}
          placeholder="https://example.com"
          keyboardType="url"
        />
      </View>
    </Dialog>
  );
}
