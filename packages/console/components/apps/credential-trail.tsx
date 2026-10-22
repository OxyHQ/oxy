import { Badge } from '@oxy.so/bloom/badge';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Text, View } from 'react-native';

import { useCredentialAudit } from '@/hooks/use-applications';
import {
  credentialAuditAttribution,
  credentialAuditVariant,
  humaniseAuditToken,
} from '@/lib/credential-audit';
import { useTranslation } from '@/lib/i18n';

/**
 * One credential's audit trail: created, rotated, revoked, and every refused
 * validation.
 *
 * Nothing is projected away here — the server's wire type has no `metadata`
 * property at all, so there is no blob to drop. See `useCredentialAudit`.
 *
 * `reason` and a null `actorUserId` are TWO CORRELATED STATES, not four
 * independent ones: a `validation_failed` row is the only kind with a reason,
 * and the only kind with no actor — because nobody performed it, a refused
 * request did. So the attribution is rendered off `eventType`
 * (`credentialAuditAttribution`), never off the nullness of `actorUserId`.
 */
export function CredentialTrail({ appId, credentialId }: { appId: string; credentialId: string }) {
  const { t } = useTranslation();
  const { data: events = [], isLoading, isError } = useCredentialAudit(appId, credentialId);

  if (isLoading) {
    return (
      <View className="border-t border-border px-4 py-3">
        <Skeleton.Box width="100%" height={60} borderRadius={10} />
      </View>
    );
  }

  if (isError) {
    return (
      <Text className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
        {t('applications.credentials.trailFailed')}
      </Text>
    );
  }

  if (events.length === 0) {
    return (
      <Text className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
        {t('applications.credentials.trailEmpty')}
      </Text>
    );
  }

  return (
    <View className="border-t border-border">
      {events.map((event, index) => (
        <View
          key={`${event.eventType}-${event.reason ?? 'none'}-${event.createdAt}`}
          className={
            index > 0
              ? 'flex-row flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2'
              : 'flex-row flex-wrap items-center justify-between gap-2 px-4 py-2'
          }
        >
          <View className="flex-row flex-wrap items-center gap-2">
            <Badge
              content={humaniseAuditToken(event.eventType)}
              size="label-small"
              variant={credentialAuditVariant(event) === 'destructive' ? 'subtle' : 'outlined'}
              color={credentialAuditVariant(event) === 'destructive' ? 'error' : 'default'}
            />
            {event.reason !== null ? (
              <Badge
                content={humaniseAuditToken(event.reason)}
                size="label-small"
                variant="subtle"
                color="default"
              />
            ) : null}
            <Text className="text-xs text-muted-foreground">
              {event.environment ?? t('applications.credentials.noEnvironment')} ·{' '}
              {credentialAuditAttribution(event)}
            </Text>
            {/* A rotation grace deadline, when the event set one. */}
            {event.effectiveUntil !== null ? (
              <Text className="text-xs text-muted-foreground">
                {t('applications.credentials.until', {
                  when: new Date(event.effectiveUntil).toLocaleString(),
                })}
              </Text>
            ) : null}
          </View>
          <Text className="text-xs text-muted-foreground">
            {new Date(event.createdAt).toLocaleString()}
          </Text>
        </View>
      ))}
    </View>
  );
}
