import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { useTranslation } from '@/lib/i18n';

/**
 * A refusal, said as a refusal.
 *
 * An audit trail is the one screen where narrowing a result to what the caller
 * may see is the wrong answer: a list covering half an account, rendered like a
 * whole one, reads as complete and is not. The missing permissions are NAMED so
 * the customer has something to ask their account owner for.
 */
export function AuditRefusal({
  missing,
  what,
}: {
  /** The permissions the caller lacks, in the API's own vocabulary. */
  readonly missing: ReadonlyArray<string>;
  /** What is being refused, for the first sentence. */
  readonly what: string;
}) {
  const { t } = useTranslation();
  return (
    <AdmonitionRoot type="warning">
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          <AdmonitionText style={{ fontWeight: '600' }}>
            {t('reportKit.refusal.title', { what })}
          </AdmonitionText>
          <AdmonitionText>
            {t(missing.length === 1 ? 'reportKit.refusal.needsOne' : 'reportKit.refusal.needsMany')}{' '}
            {missing.join(', ')}.
          </AdmonitionText>
          <AdmonitionText>{t('reportKit.refusal.body')}</AdmonitionText>
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}
