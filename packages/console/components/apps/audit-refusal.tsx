import { Admonition } from '@oxy.so/bloom/admonition';
import { Code } from '@oxy.so/bloom/code';
import { Text } from '@oxy.so/bloom/typography';

import { useTranslation } from '@/lib/i18n';

/**
 * A refusal, said as a refusal.
 *
 * An audit trail is the one screen where narrowing a result to what the caller
 * may see is the wrong answer: a list covering half an account reads as complete
 * and is not. The missing permissions are NAMED so the person has something to
 * ask their account owner for.
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
    <Admonition type="error">
      <Text variant="body-2-semibold">{t('applications.refusal.title', { what })}</Text>
      {'\n'}
      {missing.length === 1
        ? t('applications.refusal.needsOne')
        : t('applications.refusal.needsMany')}{' '}
      {missing.map((permission, index) => (
        <Text key={permission}>
          {index > 0 ? ', ' : ''}
          <Code>{permission}</Code>
        </Text>
      ))}
      {'\n'}
      {t('applications.refusal.body')}
    </Admonition>
  );
}
