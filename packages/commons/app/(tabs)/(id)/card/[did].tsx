import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import {
  Screen,
  StackHeader,
  Section,
  GroupedList,
  ListRow,
  PrimaryButton,
  SecondaryButton,
  CenteredState,
} from '@/components/ui';
import { CivicBadge } from '@/components/civic/CivicBadge';
import { useCivicCard } from '@/hooks/useCivicCard';
import { usePersonhood } from '@/hooks/usePersonhood';
import { useCivicProfileState } from '@/hooks/useCivicProfileState';
import { userIdFromDid } from '@/lib/civic/did';
import {
  getVerificationMeta,
  getTrustTierMeta,
  getPersonhoodMeta,
} from '@/lib/civic/card-presentation';
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
  const { t } = useTranslation();
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
        <CenteredState
          icon="qrcode-remove"
          title={t('civic.card.error.invalidTitle')}
          body={t('civic.card.error.invalidBody')}
        />
      );
    }

    // First resolve with nothing cached yet.
    if (cardQuery.isPending && !card) {
      return <CenteredState loading body={t('civic.card.loading')} />;
    }

    // Failed to resolve and we have no cached card to fall back to.
    if (cardQuery.isError && !card) {
      return (
        <CenteredState
          icon="cloud-alert"
          title={t('civic.card.error.title')}
          body={t('civic.card.error.body')}
          action={
            <View style={styles.action}>
              <PrimaryButton label={t('common.retry')} onPress={() => cardQuery.refetch()} fullWidth={false} />
            </View>
          }
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
        <View style={styles.verdict}>
          <CivicBadge
            emphasis
            tone={verification.tone}
            icon={verified ? 'check-decagram' : 'alert-decagram'}
            label={t(`civic.card.${verification.labelKey}`)}
          />
          <ThemedText style={[styles.verdictDesc, { color: colors.textSecondary }]}>
            {t(`civic.card.${verification.labelKey}Desc`)}
          </ThemedText>
          {!isOnline && (
            <CivicBadge tone="neutral" icon="cloud-off-outline" label={t('civic.card.offline')} />
          )}
        </View>

        {/* Identity */}
        <View style={styles.identity}>
          <View style={styles.identityRow}>
            {card.avatarUrl ? (
              <Image source={{ uri: card.avatarUrl }} style={styles.avatar} resizeMode="cover" />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder, { backgroundColor: colors.border }]}>
                <Text style={[styles.avatarInitial, { color: colors.textSecondary }]}>
                  {card.name?.charAt(0)?.toUpperCase() || '?'}
                </Text>
              </View>
            )}
            <View style={styles.identityText}>
              <ThemedText style={styles.name} numberOfLines={2}>
                {card.name}
              </ThemedText>
              {card.username && (
                <ThemedText style={[styles.username, { color: colors.textSecondary }]} numberOfLines={1}>
                  @{card.username}
                </ThemedText>
              )}
            </View>
          </View>

          <View style={styles.badgeRow}>
            <CivicBadge tone={trust.tone} icon="shield-check" label={t(`civic.trustTier.${trust.labelKey}`)} />
            <CivicBadge
              tone={personhoodMeta.tone}
              icon="account-check-outline"
              label={t(`civic.personhood.${personhoodMeta.labelKey}`)}
            />
          </View>

          {/* Precise proof-of-personhood status (from getPersonhood). */}
          {personhood && (
            <View style={styles.personhoodLine}>
              <MaterialCommunityIcons
                name={personhood.isRealPerson ? 'account-check' : 'account-clock-outline'}
                size={16}
                color={personhood.isRealPerson ? colors.success : colors.warning}
              />
              <ThemedText style={[styles.personhoodLineText, { color: colors.textSecondary }]}>
                {personhood.isRealPerson
                  ? t('civic.vouch.statusLine.verified')
                  : t('civic.vouch.statusLine.building', {
                      pct: Math.max(0, Math.min(100, Math.round(personhood.score * 100))),
                    })}
              </ThemedText>
            </View>
          )}
        </View>

        {/* Vouch + issue-credential CTAs — only for a card whose signature verified. */}
        {verified && (
          <View style={styles.ctas}>
            <PrimaryButton
              icon="account-multiple-check-outline"
              label={t('civic.vouch.cta')}
              onPress={handleVouch}
            />
            <SecondaryButton
              icon="certificate-outline"
              label={t('civic.credentials.issue.cardCta')}
              onPress={handleIssueCredential}
            />
          </View>
        )}

        {card.verifiedDomains.length > 0 && (
          <Section title={t('civic.card.verifiedDomains')}>
            <GroupedList>
              {card.verifiedDomains.map((domain) => (
                <ListRow key={domain} icon="web-check" iconColor={colors.success} title={domain} />
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
                  icon="certificate-outline"
                  iconColor={colors.identityIconPublicKey}
                  title={badge}
                />
              ))}
            </GroupedList>
          </Section>
        )}

        <Section title={t('civic.card.didLabel')}>
          <ThemedText style={[styles.didValue, { color: colors.textSecondary }]} selectable numberOfLines={2}>
            {card.did}
          </ThemedText>
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
  action: {
    alignItems: 'center',
    marginTop: 4,
  },
  verdict: {
    gap: 12,
    alignItems: 'flex-start',
  },
  verdictDesc: {
    fontSize: 14,
    lineHeight: 20,
  },
  identity: {
    gap: 12,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
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
  identityText: {
    flex: 1,
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
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  personhoodLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  personhoodLineText: {
    fontSize: 13,
  },
  ctas: {
    gap: 12,
  },
  didValue: {
    fontSize: 13,
    lineHeight: 19,
  },
});
