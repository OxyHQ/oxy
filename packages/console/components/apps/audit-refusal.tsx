import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { Text, View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { Code, MutedIcon } from './primitives';

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
    <View className="max-w-2xl flex-row items-start gap-3 rounded-lg border border-border bg-muted px-5 py-4">
      <View className="mt-0.5">
        <MutedIcon icon={RiShieldLine} size={18} />
      </View>
      <View className="min-w-0 flex-1 gap-2">
        <Text className="text-sm font-semibold text-foreground">
          {t('applications.refusal.title', { what })}
        </Text>
        <View className="flex-row flex-wrap items-center gap-1">
          <Text className="text-sm text-muted-foreground">
            {missing.length === 1
              ? t('applications.refusal.needsOne')
              : t('applications.refusal.needsMany')}
          </Text>
          {missing.map((permission) => (
            <Code key={permission}>{permission}</Code>
          ))}
        </View>
        <Text className="text-sm text-muted-foreground">{t('applications.refusal.body')}</Text>
      </View>
    </View>
  );
}
