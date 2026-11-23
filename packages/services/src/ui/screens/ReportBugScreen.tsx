import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { Text } from '@oxy.so/bloom/typography';
import { toast } from '@oxy.so/bloom/toast';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export default function ReportBugScreen() {
  const styles = useStyles();
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [opening, setOpening] = useState(false);
  useSurfaceHeader({ title: t('help.reportBug.title') });

  const openDraft = async () => {
    setAttempted(true);
    if (!title.trim() || !description.trim() || opening) return;
    setOpening(true);
    try {
      await Linking.openURL(
        `mailto:bugs@oxy.so?subject=${encodeURIComponent(title.trim())}&body=${encodeURIComponent(description.trim())}`,
      );
    } catch {
      toast.error(t('help.reportError'));
    } finally {
      setOpening(false);
    }
  };

  return (
    <View style={styles.container}>
      <Field
        label={t('help.reportBug.summary')}
        error={attempted && !title.trim() ? t('help.reportBug.summaryRequired') : undefined}
      >
        <TextFieldInput
          label={t('help.reportBug.summary')}
          value={title}
          onValueChange={setTitle}
          maxLength={120}
        />
      </Field>
      <Field
        label={t('help.reportBug.description')}
        error={
          attempted && !description.trim() ? t('help.reportBug.descriptionRequired') : undefined
        }
      >
        <Textarea
          label={t('help.reportBug.description')}
          value={description}
          onValueChange={setDescription}
          placeholder={t('help.reportBug.descriptionHint')}
          maxLength={4000}
        />
      </Field>
      <Text style={styles.mutedText}>{t('help.reportBug.emailHint')}</Text>
      <Button onPress={openDraft} disabled={opening}>
        {t('help.reportBug.continueEmail')}
      </Button>
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  container: { gap: 16, paddingHorizontal: 20, paddingBottom: 24 },
  mutedText: { color: t.mutedForeground },
}));
