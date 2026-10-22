import { Badge } from '@oxy.so/bloom/badge';
import type { InferenceMessage } from '@oxy.so/contracts';
import { Text, View } from 'react-native';

import { useTranslation } from '@/lib/i18n';

/**
 * One message of the normalized output.
 *
 * A message's content is always a LIST of parts, and only the `text` parts have
 * anything to print. An image or audio part is named rather than rendered: the
 * playground is not a media viewer, and silently dropping a part would make a
 * multimodal answer look truncated.
 */
export function PlaygroundOutput({ message }: { message: InferenceMessage }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1">
      <Text className="text-xs capitalize text-muted-foreground">{message.role}</Text>
      {message.content.map((part, index) =>
        part.type === 'text' ? (
          <Text key={index} selectable className="text-sm text-foreground">
            {part.text}
          </Text>
        ) : (
          <View key={index} className="items-start">
            <Badge
              size="label-small"
              variant="outlined"
              content={t('playgroundPage.output.nonText', { type: part.type })}
            />
          </View>
        ),
      )}
      {message.toolCalls?.map((call) => (
        <View key={call.id} className="gap-1 rounded border border-border p-2">
          <Text className="font-mono text-xs text-foreground">{call.name}</Text>
          <Text selectable className="font-mono text-xs text-muted-foreground">
            {call.arguments}
          </Text>
        </View>
      ))}
    </View>
  );
}
