import { View } from 'react-native';
import { Muted } from '@oxy.so/bloom/typography';
import { LanguagePicker } from '@/components/settings/language-picker';
import { useTranslation } from '@/lib/i18n';

/** The display-language picker. */
export function LanguageSection() {
  const { t } = useTranslation();
  return (
    <View className="max-w-xs gap-3">
      <Muted>{t('settings.language.subtitle')}</Muted>
      <LanguagePicker />
    </View>
  );
}
