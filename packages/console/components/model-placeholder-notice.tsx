import { Notice } from '@/components/content/Notice';
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
  const vars = { model: MODEL_ID_PLACEHOLDER, revision: MODEL_REVISION_PLACEHOLDER };
  return (
    <Notice
      className={className}
      title={t('notices.placeholder.title', vars)}
      paragraphs={[t('notices.placeholder.body', vars)]}
    />
  );
}
