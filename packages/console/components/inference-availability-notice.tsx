import { Notice } from '@/components/content/Notice';
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
 */
export function InferenceAvailabilityNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Notice
      className={className}
      title={t('notices.inference.title')}
      paragraphs={[t('notices.inference.paragraphOne'), t('notices.inference.paragraphTwo')]}
    />
  );
}
