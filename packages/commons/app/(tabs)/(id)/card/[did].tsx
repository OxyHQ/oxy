import React, { useCallback, useMemo } from 'react';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { fullWidthControl } from '@/constants/styles';
import { Button } from '@oxy.so/bloom/button';
import { AppIcon, Icons } from '@/constants/icons';
import { View, Text, StyleSheet, Image } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import {
  Screen,
  StackHeader,
  Section,
  GroupedList,
  ListRow,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
import { useCivicCard } from '@/hooks/useCivicCard';
import { usePersonhood } from '@/hooks/usePersonhood';
import { useCivicProfileState } from '@/hooks/useCivicProfileState';
import { userIdFromDid } from '@/lib/civic/did';
import { trustTierLabel } from '@oxy.so/core';
import { bloomToneFor, getPersonhoodMeta, getTrustTierMeta, getVerificationMeta } from '@/lib/civic/card-presentation';
import { useTranslation } from '@/lib/i18n';

/**
 * Scanned-person view — resolves and renders another person's signed Oxy ID card.
 *
 * The `did` route param comes from a scanned `oxycommons://card?did=…` payload;
 * the subject's `userId` is recovered from it and the signed card resolved +
 * verified client-side via `useCivicCard`. The verdict drives an explicit
 * VERIFIED ✓ / UNVERIFIED ⚠ indicator — a `verified: false` card (forged,
 * unsigned, or tampered) is surfaced as untrusted, never silently trusted.
 *
 * Offline-first: a previously-resolved card is served from cache with an
 * "offline" chip; a never-seen card while offline shows the error affordance.
 */
export default function ScannedCardScreen() {
  const colors = useColors();
  const router = useRouter();
  const { t, locale } = useTranslation();
  const { did } = useLocalSearchParams<{ did: string }>();

  const userId = useMemo(() => (did ? userIdFromDid(did) : null), [did]);

  const cardQuery = useCivicCard(userId);
  const personhoodQuery = usePersonhood(userId);
  const { isOnline } = useCivicProfileState({ subject: 'remote' });

  const card = cardQuery.data?.card;
  const verified = cardQuery.data?.verified ?? false;
  const personhood = personhoodQuery.data;

  const handleClose = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/(id)');
    }
  }, [router]);

  const handleVouch = useCallback(() => {
    if (!did) return;
    router.push({ pathname: '/(tabs)/(id)/vouch/[did]', params: { did } });
  }, [router, did]);

  const handleIssueCredential = useCallback(() => {
    if (!did) return;
    router.push({ pathname: '/(tabs)/(id)/credential/[did]', params: { did } });
  }, [router, did]);

  const renderBody = () => {
    // The DID could not be parsed into a user id — not a valid Oxy ID.
    if (!userId) {
      return (
        <EmptyState
          icon={Icons.closeCircle}
          title={t('civic.card.error.invalidTitle')}
          description={t('civic.card.error.invalidBody')}
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    // First resolve with nothing cached yet.
    if (cardQuery.isPending && !card) {
      return <LoadingState description={t('civic.card.loading')} />;
    }

    // Failed to resolve and we have no cached card to fall back to.
    if (cardQuery.isError && !card) {
      return (
        <EmptyState
          icon={Icons.alert}
          title={t('civic.card.error.title')}
          description={t('civic.card.error.body')}
          footer={
            <View className="items-center mt-space-4">
              <Button appearance="solid" tone="accent" size="lg" onPress={() => cardQuery.refetch()}>{t('common.retry')}</Button>
            </View>
          }
          minHeight={STATE_MIN_HEIGHT}
        />
      );
    }

    if (!card) return null;

    const verification = getVerificationMeta(verified);
    const trust = getTrustTierMeta(card.trustTier);
    const personhoodMeta = getPersonhoodMeta(card.personhoodStatus);

    return (
      <>
        {/* Trust verdict — the load-bearing indicator. */}
        <View className="gap-space-12 items-start">
          <Badge
            appearance="subtle"
            tone={bloomToneFor(verification.tone)}
            size="label-medium"
            icon={Icons[verified ? 'verified' : 'alertStrong']}
            content={t(`civic.card.${verification.labelKey}`)}
          />
          <BloomText style={[styles.verdictDesc, { color: colors.textSecondary }]}>
            {t(`civic.card.${verification.labelKey}Desc`)}
          </BloomText>
          {!isOnline && (
            <Badge
              appearance="subtle"
              tone="neutral"
              size="label-small"
              icon={Icons.offline}
              content={t('civic.card.offline')}
            />
          )}
        </View>

        {/* Identity */}
        <View className="gap-space-12">
          <View className="flex-row items-center gap-space-16">
            {card.avatarUrl ? (
              <Image source={{ uri: card.avatarUrl }} style={styles.avatar} resizeMode="cover" />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder, { backgroundColor: colors.border }]}>
                <Text style={[styles.avatarInitial, { color: colors.textSecondary }]}>
                  {card.name?.charAt(0)?.toUpperCase() || '?'}
                </Text>
              </View>
            )}
            <View className="flex-1">
              <BloomText style={styles.name} numberOfLines={2}>
                {card.name}
              </BloomText>
              {card.username && (
                <BloomText style={[styles.username, { color: colors.textSecondary }]} numberOfLines={1}>
                  @{card.username}
                </BloomText>
              )}
            </View>
          </View>

          <View className="flex-row flex-wrap gap-space-8">
            <Badge
              appearance="subtle"
              tone={bloomToneFor(trust.tone)}
              size="label-small"
              icon={Icons.shieldCheck}
              content={trustTierLabel(locale, trust.labelKey)}
            />
            <Badge
              appearance="subtle"
              tone={bloomToneFor(personhoodMeta.tone)}
              size="label-small"
              icon={Icons.vouched}
              content={t(`civic.personhood.${personhoodMeta.labelKey}`)}
            />
          </View>

          {/* Precise proof-of-personhood status (from getPersonhood). */}
          {personhood && (
            <View style={styles.personhoodLine}>
              <AppIcon name={personhood.isRealPerson ? 'vouched' : 'pending'} size='sm' fill={personhood.isRealPerson ? colors.success : colors.warning} />
              <BloomText style={[styles.personhoodLineText, { color: colors.textSecondary }]}>
                {personhood.isRealPerson
                  ? t('civic.vouch.statusLine.verified')
                  : t('civic.vouch.statusLine.building', {
                      pct: Math.max(0, Math.min(100, Math.round(personhood.score * 100))),
                    })}
              </BloomText>
            </View>
          )}
        </View>

        {/* Vouch + issue-credential CTAs — only for a card whose signature verified. */}
        {verified && (
          <View className="gap-space-12">
            <Button appearance="solid" tone="accent" size="lg" icon={Icons.vouched} onPress={handleVouch} style={fullWidthControl}>{t('civic.vouch.cta')}</Button>
            <Button appearance="outline" tone="accent" size="lg" icon={Icons.credential} onPress={handleIssueCredential} style={fullWidthControl}>{t('civic.credentials.issue.cardCta')}</Button>
          </View>
        )}

        {card.verifiedDomains.length > 0 && (
          <Section title={t('civic.card.verifiedDomains')}>
            <GroupedList>
              {card.verifiedDomains.map((domain) => (
                <ListRow key={domain} icon="web" iconColor={colors.success} title={domain} />
              ))}
            </GroupedList>
          </Section>
        )}

        {card.credentialBadges.length > 0 && (
          <Section title={t('civic.card.credentials')}>
            <GroupedList>
              {card.credentialBadges.map((badge) => (
                <ListRow
                  key={badge}
                  icon="credential"
                  iconColor={colors.identityIconPublicKey}
                  title={badge}
                />
              ))}
            </GroupedList>
          </Section>
        )}

        <Section title={t('civic.card.didLabel')}>
          <BloomText style={[styles.didValue, { color: colors.textSecondary }]} selectable numberOfLines={2}>
            {card.did}
          </BloomText>
        </Section>
      </>
    );
  };

  return (
    <Screen gap={24}>
      <StackHeader
        title={t('civic.card.title')}
        onClose={handleClose}
        closeAccessibilityLabel={t('common.close')}
      />
      {renderBody()}
    </Screen>
  );
}

const styles = StyleSheet.create({
  verdict: {
    gap: 12,
    alignItems: 'flex-start',
  },
  verdictDesc: {
    fontSize: 14,
    lineHeight: 20,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 28,
    fontWeight: '600',
  },
  name: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  username: {
    fontSize: 15,
    marginTop: 2,
  },
  personhoodLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  personhoodLineText: {
    fontSize: 13,
  },
  didValue: {
    fontSize: 13,
    lineHeight: 19,
  },
});
