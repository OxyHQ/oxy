import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text, View } from 'react-native';
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
  const theme = useTheme();
  return (
    <View className="mx-6 my-8 max-w-2xl rounded-lg border border-border bg-muted px-5 py-4">
      <View className="flex-row items-start gap-3">
        <View className="mt-0.5">
          <Icon color={theme.colors.textSecondary} />
        </View>
        <View className="min-w-0 flex-1 gap-2">
          <Text className="text-sm font-semibold text-foreground">
            {t('reportKit.refusal.title', { what })}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t(missing.length === 1 ? 'reportKit.refusal.needsOne' : 'reportKit.refusal.needsMany')}{' '}
            <Text className="font-mono text-xs text-foreground">{missing.join(', ')}</Text>.
          </Text>
          <Text className="text-sm text-muted-foreground">{t('reportKit.refusal.body')}</Text>
        </View>
      </View>
    </View>
  );
}

function Icon({ color }: { color: string }) {
  return <RiShieldLine size="md" fill={color} />;
}
