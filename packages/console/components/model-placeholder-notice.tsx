import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { InlineMarkdown, Markdown } from '@oxy.so/bloom/markdown';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { MODEL_ID_PLACEHOLDER, MODEL_REVISION_PLACEHOLDER } from '@/lib/model-reference';

/**
 * The one statement about why the samples carry a placeholder model.
 *
 * Answers a different question from `InferenceAvailabilityNotice`: that one says
 * who may call the endpoint, this one says what to write in the `model` field.
 */
export function ModelPlaceholderNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const vars = { model: MODEL_ID_PLACEHOLDER, revision: MODEL_REVISION_PLACEHOLDER };
  return (
    <View className={className}>
      <AdmonitionRoot type="info">
        <AdmonitionRow>
          <AdmonitionIcon />
          <AdmonitionContent>
            <AdmonitionText>
              <InlineMarkdown source={t('notices.placeholder.title', vars)} />
            </AdmonitionText>
            <Markdown size="sm" onLinkPress={(url) => router.navigate(url as never)}>
              {t('notices.placeholder.body', vars)}
            </Markdown>
          </AdmonitionContent>
        </AdmonitionRow>
      </AdmonitionRoot>
    </View>
  );
}
