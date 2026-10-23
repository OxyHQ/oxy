import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { LOCALE_LABELS, SUPPORTED_LOCALES, useTranslation } from '@/lib/i18n';

export function LanguagePage() {
  const { t, locale, setLocale } = useTranslation();
  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'language',
          rows: [
            {
              key: 'locale',
              label: t('settings.language.title'),
              description: t('settings.language.subtitle'),
              control: (
                <SettingsSelect
                  label={t('language.picker.ariaLabel')}
                  value={locale}
                  onChange={setLocale}
                  items={SUPPORTED_LOCALES.map((value) => ({
                    value,
                    label: LOCALE_LABELS[value],
                  }))}
                />
              ),
            },
          ],
        },
      ]}
    />
  );
}
