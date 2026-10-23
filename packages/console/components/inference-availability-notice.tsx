import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { InlineMarkdown, Markdown } from '@oxy.so/bloom/markdown';
import { View } from 'react-native';

import { useModelCatalogue } from '@/hooks/use-models';
import { useTranslation } from '@/lib/i18n';

/**
 * The one statement about what happens when you call the inference API today.
 *
 * It says "nobody is served yet" rather than "you are not allowed": the public
 * inference edge authenticates an ordinary `oxy_sk_…` machine credential fine and
 * refuses for an entirely different reason, and a developer acts on the two
 * differently. Sits beside `ModelPlaceholderNotice`, which answers what to write
 * in the `model` field. Both are components so the fact is stated once, in one
 * wording, instead of drifting across seven pages.
 *
 * It is shown only while the live catalogue is loaded and empty: that is the one
 * observable sign that nothing is served. A populated catalogue contradicts "not
 * serving requests yet", so the notice stays out of the way then.
 */
export function InferenceAvailabilityNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  const catalogue = useModelCatalogue();
  if (!catalogue.isSuccess || catalogue.data.length > 0) return null;
  return (
    <View className={className}>
      <AdmonitionRoot type="info">
        <AdmonitionRow>
          <AdmonitionIcon />
          <AdmonitionContent>
            <AdmonitionText>
              <InlineMarkdown source={t('notices.inference.title')} />
            </AdmonitionText>
            <Markdown size="sm">{t('notices.inference.paragraphOne')}</Markdown>
            <Markdown size="sm">{t('notices.inference.paragraphTwo')}</Markdown>
          </AdmonitionContent>
        </AdmonitionRow>
      </AdmonitionRoot>
    </View>
  );
}
