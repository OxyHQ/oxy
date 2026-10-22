import { Card, CardBody, CardHeader, CardTitle } from '@oxy.so/bloom/card';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Item } from '@oxy.so/bloom/item';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { ContentClaimCounterNoticeView, ContentClaimDetailView } from '@oxy.so/contracts';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';
import { ClaimDeadlineBadge, ClaimStateBadge } from './ClaimBadges';

/** A labelled free-text statement, shown in full: it is someone's own words. */
function Statement({ label, children }: { label: string; children: string }) {
  return (
    <View className="gap-1">
      <Muted className="text-xs">{label}</Muted>
      <Text selectable>{children}</Text>
    </View>
  );
}

/**
 * One owner's counter-notice (17 U.S.C. § 512(g)(3)), as they sent it. For a copyright
 * claim the claimant was sent this notice, contact details included; for any other
 * kind, only that it is disputed.
 */
function CounterNotice({ notice }: { notice: ContentClaimCounterNoticeView }) {
  const { t } = useTranslation();
  const statement = notice.statement;
  return (
    <Card>
      <CardBody>
        <View className="gap-4">
          <Muted className="text-xs">
            {t('claimsPage.counterNotice.sent', {
              date: new Date(notice.createdAt).toLocaleString(),
              by: notice.submittedByUserId
                ? t('claimsPage.counterNotice.by', { user: notice.submittedByUserId })
                : '',
              count: notice.fileIds.length,
              version: notice.statementVersion,
            })}
          </Muted>
          {statement === null ? (
            <Muted>{t('claimsPage.counterNotice.erased')}</Muted>
          ) : (
            <View className="gap-3">
              <Statement label={t('claimsPage.counterNotice.name')}>{statement.name}</Statement>
              <Statement label={t('claimsPage.counterNotice.address')}>
                {statement.address}
              </Statement>
              <Statement label={t('claimsPage.counterNotice.phone')}>{statement.phone}</Statement>
              <Statement label={t('claimsPage.counterNotice.email')}>{statement.email}</Statement>
              <Statement label={t('claimsPage.counterNotice.material')}>
                {statement.materialDescription}
              </Statement>
              <Statement label={t('claimsPage.counterNotice.location')}>
                {statement.materialLocation}
              </Statement>
              <Statement label={t('claimsPage.counterNotice.explanation')}>
                {statement.explanation}
              </Statement>
              <Statement label={t('claimsPage.counterNotice.signature')}>
                {statement.signature}
              </Statement>
            </View>
          )}
          <Muted selectable className="text-xs">
            {t('claimsPage.counterNotice.files', { ids: notice.fileIds.join(', ') })}
          </Muted>
        </View>
      </CardBody>
    </Card>
  );
}

/** The claim itself: where it stands, who made it and what they said, and any counter-notices. */
export function ClaimOverview({ claim }: { claim: ContentClaimDetailView }) {
  const { t } = useTranslation();
  const { claimant } = claim;

  return (
    <View className="gap-6">
      <GroupedSection separator="line">
        <GroupedSectionItem
          title={t('claimsPage.columns.state')}
          rightElement={
            <View className="flex-row flex-wrap items-center justify-end gap-2">
              <ClaimDeadlineBadge claim={claim} />
              <ClaimStateBadge state={claim.state} />
            </View>
          }
        />
        <GroupedSectionItem
          title={t('claimsPage.columns.kind')}
          value={t(`claimsPage.kinds.${claim.kind}`)}
        />
        <GroupedSectionItem
          title={t('claimsPage.detail.relationship')}
          value={t(`claimsPage.relationships.${claim.relationship}`)}
        />
        <GroupedSectionItem
          title={t('claimsPage.columns.received')}
          value={new Date(claim.receivedAt).toLocaleString()}
        />
        {claim.closedAt && (
          <GroupedSectionItem
            title={t('claimsPage.detail.closedLabel')}
            value={new Date(claim.closedAt).toLocaleString()}
          />
        )}
        {claim.submittedByUserId && (
          <GroupedSectionItem
            title={t('claimsPage.detail.submittedLabel')}
            value={claim.submittedByUserId}
          />
        )}
        {claim.deadlineAt && (
          <GroupedSectionItem
            title={t('claimsPage.columns.deadline')}
            description={t('claimsPage.detail.deadline', {
              date: new Date(claim.deadlineAt).toLocaleDateString(),
            })}
          />
        )}
      </GroupedSection>

      <Card>
        <CardHeader>
          <CardTitle>{t('claimsPage.sections.claimant')}</CardTitle>
        </CardHeader>
        <CardBody>
          {claimant === null ? (
            <Muted>
              {claim.claimantExpiresAt
                ? t('claimsPage.claimant.erasedOn', {
                    date: new Date(claim.claimantExpiresAt).toLocaleDateString(),
                  })
                : t('claimsPage.claimant.erased')}
            </Muted>
          ) : (
            <View className="gap-3">
              <Item
                density="compact"
                title={t('claimsPage.claimant.name')}
                subtitle={claimant.name}
              />
              <Item
                density="compact"
                title={t('claimsPage.claimant.email')}
                subtitle={claimant.email}
              />
              {claimant.organization ? (
                <Item
                  density="compact"
                  title={t('claimsPage.claimant.organization')}
                  subtitle={claimant.organization}
                />
              ) : null}
              <Item
                density="compact"
                title={t('claimsPage.claimant.signature')}
                subtitle={claimant.signature}
              />
              {claimant.originalWorkUrl ? (
                <Item
                  density="compact"
                  title={t('claimsPage.claimant.originalWork')}
                  subtitle={claimant.originalWorkUrl}
                />
              ) : null}
              <Statement label={t('claimsPage.claimant.statement')}>
                {claimant.description}
              </Statement>
            </View>
          )}
        </CardBody>
      </Card>

      {claim.counterNotices.length > 0 && (
        <View className="gap-3">
          <Text className="font-semibold">{t('claimsPage.sections.counterNotices')}</Text>
          {claim.counterNotices.map((notice) => (
            <CounterNotice key={notice.id} notice={notice} />
          ))}
        </View>
      )}
    </View>
  );
}
