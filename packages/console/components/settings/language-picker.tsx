import { View } from 'react-native';
import { OptionSelect } from '@/components/account-pages/OptionSelect';
import { LOCALE_LABELS, type Locale, SUPPORTED_LOCALES, useTranslation } from '@/lib/i18n';

const OPTIONS = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] }));

/** Compact language picker: Bloom's Select over the console's supported locales. */
export function LanguagePicker() {
  const { t, locale, setLocale } = useTranslation();

  return (
    <View className="max-w-xs">
      <OptionSelect<Locale>
        label={t('language.picker.ariaLabel')}
        value={locale}
        options={OPTIONS}
        onChange={setLocale}
      />
    </View>
  );
}
