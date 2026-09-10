import React, { useMemo } from 'react';
import { View, StyleSheet, Text, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import type { RouteName } from '@oxy.so/services';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import { AccountCard } from '@/components/ui';
import { ContactMatchesList } from '@/components/contact-matches-list';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';
import type { PermissionStatus } from 'expo-contacts';
import type { ContactMatch } from '@/hooks/sharing/useContactSync';

type ShowBottomSheet = (
  screenOrConfig: RouteName | { screen: RouteName; props?: Record<string, unknown> },
) => void;

interface ContactsSectionProps {
  userId: string | undefined;
  showBottomSheet?: ShowBottomSheet;
  followerCount: number | null | undefined;
  followingCount: number | null | undefined;
  contactsPermission: PermissionStatus | null;
  isSyncingContacts: boolean;
  deviceContactsCount: number | null;
  contactMatches: ContactMatch[];
  onSyncContacts: () => void;
}

/**
 * Contacts section: sync-from-device (native only), follower/following counts,
 * and a "find people" link — plus the resolved contact matches rendered below
 * the card after a sync. Extracted from the People & Sharing screen; the inline
 * `contactsItems` memo and the matches container now live here.
 */
export function ContactsSection({
  userId,
  showBottomSheet,
  followerCount,
  followingCount,
  contactsPermission,
  isSyncingContacts,
  deviceContactsCount,
  contactMatches,
  onSyncContacts,
}: ContactsSectionProps) {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();

  const contactsItems = useMemo<GroupedItem[]>(() => {
    const items: GroupedItem[] = [];

    // Sync contacts from device (native only)
    if (Platform.OS !== 'web') {
      const getContactsSubtitle = () => {
        if (deviceContactsCount !== null) {
          // After a successful sync we show how many of them were found on
          // Oxy (zero is a meaningful result — encourages inviting friends).
          return t('sharing.contacts.syncResultsSummary', {
            matches: contactMatches.length,
            scanned: deviceContactsCount,
          });
        }
        if (contactsPermission === 'denied') {
          return t('sharing.contacts.syncPermissionDenied');
        }
        return t('sharing.contacts.syncDefault');
      };

      items.push({
        id: 'sync-contacts',
        icon: 'contacts-outline',
        iconColor: colors.tint,
        title:
          deviceContactsCount !== null
            ? t('sharing.contacts.syncRefresh')
            : t('sharing.contacts.syncTitle'),
        subtitle: getContactsSubtitle(),
        onPress: onSyncContacts,
        showChevron: true,
        customContent: isSyncingContacts ? (
          <ActivityIndicator size="small" color={colors.tint} />
        ) : undefined,
      });
    }

    // Followers
    items.push({
      id: 'followers',
      icon: 'account-group-outline',
      iconColor: colors.sidebarIconSharing,
      title: t('sharing.contacts.followers'),
      subtitle: followerCount !== undefined && followerCount !== null
        ? t('sharing.contacts.followersFollowing', { count: followerCount })
        : t('sharing.contacts.followersDefault'),
      onPress: () => {
        if (userId) {
          showBottomSheet?.({ screen: 'FollowersList', props: { userId, initialCount: followerCount } });
        }
      },
      showChevron: true,
    });

    // Following
    items.push({
      id: 'following',
      icon: 'account-heart-outline',
      iconColor: colors.sidebarIconSharing,
      title: t('sharing.contacts.following'),
      subtitle: followingCount !== undefined && followingCount !== null
        ? t('sharing.contacts.followingCount', { count: followingCount })
        : t('sharing.contacts.followingDefault'),
      onPress: () => {
        if (userId) {
          showBottomSheet?.({ screen: 'FollowingList', props: { userId, initialCount: followingCount } });
        }
      },
      showChevron: true,
    });

    // Find people
    items.push({
      id: 'find-people',
      icon: 'account-search-outline',
      iconColor: colors.tint,
      title: t('sharing.contacts.findPeople'),
      subtitle: t('sharing.contacts.findPeopleSubtitle'),
      onPress: () => router.push('/(tabs)/search'),
      showChevron: true,
    });

    return items;
  }, [colors, followerCount, followingCount, router, onSyncContacts, isSyncingContacts, deviceContactsCount, contactMatches.length, contactsPermission, userId, showBottomSheet, t]);

  return (
    <Section title={t('sharing.sections.contacts')}>
      <Text style={[styles.sectionSubtitle, { color: colors.text }]}>
        {t('sharing.sections.contactsSubtitle')}
      </Text>
      <AccountCard>
        <GroupedSection items={contactsItems} />
      </AccountCard>
      {Platform.OS !== 'web' && deviceContactsCount !== null && !isSyncingContacts ? (
        <View style={styles.matchesContainer}>
          <Text style={[styles.matchesTitle, { color: colors.text }]}>
            {t('sharing.contacts.syncMatchesTitle')}
          </Text>
          <Text style={[styles.sectionSubtitle, { color: colors.text }]}>
            {contactMatches.length > 0
              ? t('sharing.contacts.syncMatchesSubtitle', { count: contactMatches.length })
              : t('sharing.contacts.syncNoMatchesSubtitle')}
          </Text>
          {contactMatches.length > 0 ? (
            <AccountCard>
              <ContactMatchesList matches={contactMatches} />
            </AccountCard>
          ) : null}
        </View>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  sectionSubtitle: {
    fontSize: 14,
    opacity: 0.7,
    marginBottom: 8,
  },
  matchesContainer: {
    marginTop: 12,
    gap: 4,
  },
  matchesTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
});
