import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { COLOR_PRESET_REGISTRY, FREE_COLOR_NAMES, useBloomTheme } from '@oxy.so/bloom/theme';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { useTranslation } from '@/lib/i18n';

const MODES = ['light', 'system', 'dark'] as const;
const PRESETS = COLOR_PRESET_REGISTRY.filter((preset) => FREE_COLOR_NAMES.includes(preset.name));

export function AppearancePage() {
  const { t } = useTranslation();
  const { mode, setMode, colorPreset, setColorPreset } = useBloomTheme();
  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'appearance',
          rows: [
            {
              key: 'mode',
              label: t('settingsPage.appearance.theme'),
              description: t('settingsPage.appearance.systemHint'),
              control: (
                <SettingsSelect
                  label={t('settingsPage.appearance.theme')}
                  value={mode}
                  onChange={setMode}
                  items={MODES.map((value) => ({
                    value,
                    label: t(`settingsPage.appearance.${value}`),
                  }))}
                />
              ),
            },
            {
              key: 'color',
              label: t('settingsPage.appearance.accentColor'),
              control: (
                <SettingsSelect
                  label={t('settingsPage.appearance.accentColor')}
                  value={colorPreset}
                  onChange={setColorPreset}
                  items={PRESETS.map((preset) => ({
                    value: preset.name,
                    label: preset.displayName,
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
