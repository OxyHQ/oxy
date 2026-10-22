import { DataTableFilter } from '@oxy.so/bloom/data-table';
import { LOCALE_LABELS, type Locale, SUPPORTED_LOCALES, useTranslation } from '@/lib/i18n';

const OPTIONS = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] }));

/** The console's supported locales in Bloom's option select. */
export function LanguagePicker() {
  const { t, locale, setLocale } = useTranslation();

  return (
    <DataTableFilter
      label={t('language.picker.ariaLabel')}
      value={locale}
      options={OPTIONS}
      onValueChange={(next) => setLocale(next as Locale)}
    />
  );
}
