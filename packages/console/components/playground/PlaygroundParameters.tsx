import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Slider } from '@oxy.so/bloom/slider';
import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';

/** Sampling controls; a field left `undefined` is not sent and the route's default applies. */
export interface PlaygroundParams {
  temperature?: number;
  maxOutputTokens?: number;
}

const DEFAULT_TEMPERATURE = 1;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export function PlaygroundParameters({
  params,
  onChange,
}: {
  params: PlaygroundParams;
  onChange: (params: PlaygroundParams) => void;
}) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('playgroundPage.params.title')}</CardTitle>
        <CardDescription>{t('playgroundPage.params.description')}</CardDescription>
      </CardHeader>
      <CardBody>
        <View className="gap-6">
          <View className="gap-3">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="font-medium">{t('playgroundPage.params.temperature')}</Text>
              <Switch
                accessibilityLabel={t('playgroundPage.params.temperature')}
                checked={params.temperature !== undefined}
                onCheckedChange={(on) =>
                  onChange({ ...params, temperature: on ? DEFAULT_TEMPERATURE : undefined })
                }
              />
            </View>
            {params.temperature !== undefined && (
              <Slider
                accessibilityLabel={t('playgroundPage.params.temperature')}
                min={0}
                max={2}
                step={0.1}
                value={params.temperature}
                onValueChange={(temperature) => onChange({ ...params, temperature })}
                formatValue={(value) => value.toFixed(1)}
              />
            )}
          </View>

          <View className="gap-3">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="font-medium">{t('playgroundPage.params.maxOutputTokens')}</Text>
              <Switch
                accessibilityLabel={t('playgroundPage.params.maxOutputTokens')}
                checked={params.maxOutputTokens !== undefined}
                onCheckedChange={(on) =>
                  onChange({
                    ...params,
                    maxOutputTokens: on ? DEFAULT_MAX_OUTPUT_TOKENS : undefined,
                  })
                }
              />
            </View>
            {params.maxOutputTokens !== undefined && (
              <Slider
                accessibilityLabel={t('playgroundPage.params.maxOutputTokens')}
                min={16}
                max={4096}
                step={16}
                value={params.maxOutputTokens}
                onValueChange={(maxOutputTokens) => onChange({ ...params, maxOutputTokens })}
              />
            )}
          </View>
        </View>
      </CardBody>
    </Card>
  );
}
