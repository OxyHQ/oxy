import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { CodeBlock } from '@oxy.so/bloom/code';
import { Markdown } from '@oxy.so/bloom/markdown';
import { Muted } from '@oxy.so/bloom/typography';
import type { InferenceMessage } from '@oxy.so/contracts';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';

/**
 * The normalized output. A message's content is a list of parts and only `text` parts
 * have anything to print: an image or audio part is named, not dropped, so a
 * multimodal answer never looks truncated.
 */
export function PlaygroundOutput({ output }: { output: ReadonlyArray<InferenceMessage> }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('playgroundPage.output.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <View className="gap-4">
          {output.map((message, index) => (
            <View key={index} className="gap-2">
              <Muted className="text-xs capitalize">{message.role}</Muted>
              {message.content.map((part, partIndex) =>
                part.type === 'text' ? (
                  <Markdown key={partIndex} size="md">
                    {part.text}
                  </Markdown>
                ) : (
                  <View key={partIndex} className="items-start">
                    <Chip size="sm">{t('playgroundPage.output.nonText', { type: part.type })}</Chip>
                  </View>
                ),
              )}
              {message.toolCalls?.map((call) => (
                <CodeBlock
                  key={call.id}
                  code={call.arguments}
                  filename={call.name}
                  language="json"
                  lineNumbers={false}
                  wrap
                />
              ))}
            </View>
          ))}
        </View>
      </CardBody>
    </Card>
  );
}
