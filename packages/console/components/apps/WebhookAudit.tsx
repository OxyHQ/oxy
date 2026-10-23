import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Text } from '@oxy.so/bloom/typography';

import { AuditRefusal } from '@/components/audit/audit-refusal';
import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import { useTranslation } from '@/lib/i18n';

/**
 * The signing secret's state and where the audit events are.
 *
 * ## The signing secret is never rendered, and cannot be
 *
 * `applications.webhook_secret` is regenerated server-side on every change to
 * the production URL and is serialised by no endpoint, so the row says whether
 * one exists and where it comes from.
 *
 * ## Audit events: what exists is named, and no aggregate is invented
 *
 * The only application audit read is per credential
 * (`GET /applications/:appId/credentials/:credId/audit`), gated on
 * `credentials:read`. Merging per-credential reads here would show "the newest
 * events of each credential" as this application's history, so the page points
 * at the real trails, and refuses (rather than showing an empty list) a caller
 * without `credentials:read`.
 */
export function WebhookAudit({
  application,
  access,
}: {
  application: Application;
  access: CallerAccess;
}) {
  const { t } = useTranslation();
  const { open: openSettings } = useConsoleSettings();
  const hasSecret = Boolean(application.webhookUrl);

  return (
    <>
      <GroupedSection
        title={t('applications.webhooks.secretTitle')}
        footer={
          hasSecret
            ? t('applications.webhooks.secretExistsBody')
            : t('applications.webhooks.secretNoneBody')
        }
      >
        <GroupedSectionItem
          title={
            hasSecret
              ? t('applications.webhooks.secretExists')
              : t('applications.webhooks.secretNone')
          }
          description={t('applications.webhooks.secretSubtitle')}
          rightElement={
            <Badge
              content={
                hasSecret
                  ? t('applications.webhooks.secretBadgeSet')
                  : t('applications.webhooks.secretBadgeNone')
              }
              size="label-small"
              variant={hasSecret ? 'solid' : 'subtle'}
              color={hasSecret ? 'success' : 'default'}
            />
          }
        />
      </GroupedSection>

      {/* A refusal rather than an empty list: a trail shown as "nothing has
          happened" to somebody who is simply not allowed to see it is the one
          failure an audit surface must not have. */}
      {access.can('credentials:read') ? (
        <Admonition type="info">
          <Text variant="body-2-semibold">{t('applications.webhooks.auditTitle')}</Text>
          {'\n'}
          {t('applications.webhooks.auditPerCredentialBody')}
          {'\n'}
          {t('applications.webhooks.auditNoAggregate')}{' '}
          <Text
            role="link"
            className="text-foreground underline"
            onPress={() => openSettings('audit')}
          >
            {t('applications.webhooks.auditAccountLink')}
          </Text>
          .
        </Admonition>
      ) : (
        <AuditRefusal missing={['credentials:read']} what={t('applications.webhooks.auditWhat')} />
      )}
    </>
  );
}
