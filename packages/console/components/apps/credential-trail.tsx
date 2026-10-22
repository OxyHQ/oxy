import { Admonition } from '@oxy.so/bloom/admonition';
import { Item } from '@oxy.so/bloom/item';
import * as Skeleton from '@oxy.so/bloom/skeleton';

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
    return <Skeleton.Box width="100%" height={60} borderRadius={10} />;
  }

  if (isError) {
    return <Admonition type="error">{t('applications.credentials.trailFailed')}</Admonition>;
  }

  if (events.length === 0) {
    return <Admonition type="info">{t('applications.credentials.trailEmpty')}</Admonition>;
  }

  return (
    <>
      {events.map((event) => (
        <Item
          key={`${event.eventType}-${event.reason ?? 'none'}-${event.createdAt}`}
          density="compact"
          title={humaniseAuditToken(event.eventType)}
          subtitle={[
            event.reason !== null ? humaniseAuditToken(event.reason) : null,
            event.environment ?? t('applications.credentials.noEnvironment'),
            credentialAuditAttribution(event),
            // A rotation grace deadline, when the event set one.
            event.effectiveUntil !== null
              ? t('applications.credentials.until', {
                  when: new Date(event.effectiveUntil).toLocaleString(),
                })
              : null,
            new Date(event.createdAt).toLocaleString(),
          ]
            .filter(Boolean)
            .join(' · ')}
          destructive={credentialAuditVariant(event) === 'destructive'}
        />
      ))}
    </>
  );
}
