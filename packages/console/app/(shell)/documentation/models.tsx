import { Card } from '@oxy.so/bloom/card';
import { Text, View } from 'react-native';

import { RichText } from '@/components/content/RichText';
import { DocNextSteps, DocP, DocPage, DocSection } from '@/components/docs/DocParts';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { useTranslation } from '@/lib/i18n';
import { MODEL_ID_PLACEHOLDER, MODEL_REVISION_PLACEHOLDER } from '@/lib/model-reference';

/**
 * How the catalogue is structured, not a list of models.
 *
 * This page used to hold a hardcoded array of four objects (`alia-lite`, `alia-v1`,
 * ...) and none of it was true: those names were product tiers a proxy forwarded
 * upstream, so a reader could not learn who published the weights, which revision
 * served their request or whether their data was retained. ADR 0008 retires them as
 * model identities. What a documentation page can honestly say is what the
 * identifiers MEAN; the live list lives on the Models page.
 */
const CONCEPTS = ['publisher', 'model', 'revision', 'provider', 'deployment', 'profile'] as const;

const IDENTIFIERS = [
  { key: 'model', sample: MODEL_ID_PLACEHOLDER },
  { key: 'revision', sample: MODEL_REVISION_PLACEHOLDER },
  { key: 'profile', sample: '<profile>' },
] as const;

export default function ModelsDocScreen() {
  const { t } = useTranslation();
  const vars = { model: MODEL_ID_PLACEHOLDER, revision: MODEL_REVISION_PLACEHOLDER };

  return (
    <DocPage title={t('docs.models.title')} subtitle={t('docs.models.subtitle')}>
      <DocSection title={t('docs.models.published.title')}>
        <DocP>{t('docs.models.published.body')}</DocP>
        <InferenceAvailabilityNotice />
      </DocSection>

      <DocSection title={t('docs.models.identifiers.title')}>
        {IDENTIFIERS.map(({ key, sample }) => (
          <View key={key} className="gap-2 rounded-lg border border-border p-4">
            <Text selectable className="font-mono text-sm text-foreground">
              {sample}
            </Text>
            <RichText>{t(`docs.models.identifiers.${key}`)}</RichText>
          </View>
        ))}
      </DocSection>

      <DocSection title={t('docs.models.concepts.title')}>
        <DocP>{t('docs.models.concepts.intro')}</DocP>
        {CONCEPTS.map((concept) => (
          <Card key={concept} className="gap-2 p-4">
            <Text className="text-base font-semibold text-foreground">
              {t(`docs.models.concepts.items.${concept}.name`)}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {t(`docs.models.concepts.items.${concept}.summary`)}
            </Text>
            <RichText>{t(`docs.models.concepts.items.${concept}.detail`, vars)}</RichText>
          </Card>
        ))}
      </DocSection>

      <DocSection title={t('docs.models.failover.title')}>
        {(['sameModel', 'crossModel'] as const).map((kind) => (
          <View key={kind} className="gap-2 rounded-lg border border-border p-4">
            <Text className="text-sm font-medium text-foreground">
              {t(`docs.models.failover.${kind}.title`)}
            </Text>
            <RichText>{t(`docs.models.failover.${kind}.body`)}</RichText>
          </View>
        ))}
      </DocSection>

      <DocNextSteps
        steps={[
          { href: '/models', label: t('docs.models.next.catalogue') },
          { href: '/documentation/chat-completions', label: t('docs.models.next.chat') },
        ]}
      />
    </DocPage>
  );
}
