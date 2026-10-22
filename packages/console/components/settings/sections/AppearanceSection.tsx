import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { COLOR_PRESET_REGISTRY, FREE_COLOR_NAMES, useBloomTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from '@/lib/i18n';

/** The same General page and compact Select composition used by Bloom's settings template. */
export function AppearanceSection() {
  const { t } = useTranslation();
  const { mode, setMode, colorPreset, setColorPreset } = useBloomTheme();
  const modes = (['light', 'system', 'dark'] as const).map((value) => ({
    value,
    label: t(`settingsPage.appearance.${value}`),
  }));
  const presets = COLOR_PRESET_REGISTRY.filter((preset) => FREE_COLOR_NAMES.includes(preset.name));
  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'appearance',
          label: t('settingsPage.appearance.theme'),
          rows: [
            {
              key: 'mode',
              label: t('settingsPage.appearance.theme'),
              description: t('settingsPage.appearance.systemHint'),
              control: (
                <Select
                  value={mode}
                  onValueChange={(value) => {
                    const next = modes.find((item) => item.value === value);
                    if (next) setMode(next.value);
                  }}
                >
                  <SelectTrigger
                    label={t('settingsPage.appearance.theme')}
                    className="h-8 gap-1 px-2 py-1.5"
                  >
                    <SelectValue>
                      {() => modes.find((item) => item.value === mode)?.label}
                    </SelectValue>
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent
                    label={t('settingsPage.appearance.theme')}
                    items={modes}
                    valueExtractor={(item) => item.value}
                    renderItem={(item) => (
                      <SelectItem value={item.value} label={item.label}>
                        <SelectItemIndicator />
                        <SelectItemText>{item.label}</SelectItemText>
                      </SelectItem>
                    )}
                  />
                </Select>
              ),
            },
            {
              key: 'color',
              label: t('settingsPage.appearance.accentColor'),
              control: (
                <Select
                  value={colorPreset}
                  onValueChange={(value) => {
                    const preset = presets.find((item) => item.name === value);
                    if (preset) setColorPreset(preset.name);
                  }}
                >
                  <SelectTrigger
                    label={t('settingsPage.appearance.accentColor')}
                    className="h-8 gap-1 px-2 py-1.5"
                  >
                    <SelectValue>
                      {() =>
                        COLOR_PRESET_REGISTRY.find((preset) => preset.name === colorPreset)
                          ?.displayName
                      }
                    </SelectValue>
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent
                    label={t('settingsPage.appearance.accentColor')}
                    items={presets}
                    valueExtractor={(item) => item.name}
                    renderItem={(item) => (
                      <SelectItem value={item.name} label={item.displayName}>
                        <SelectItemIndicator />
                        <SelectItemText>{item.displayName}</SelectItemText>
                      </SelectItem>
                    )}
                  />
                </Select>
              ),
            },
          ],
        },
      ]}
    />
  );
}
