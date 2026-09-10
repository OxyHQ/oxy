import React from 'react';
import { View, StyleSheet, Text, ActivityIndicator } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ScreenHeader } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy } from '@oxy.so/services';
import { useTranslation } from '@/lib/i18n';
import { useContactSync } from '@/hooks/sharing/useContactSync';
import { usePrivacyCounts } from '@/hooks/sharing/usePrivacyCounts';
import { ContactsSection } from '@/components/sharing/contacts-section';
import { ProfileVisibilitySection } from '@/components/sharing/profile-visibility-section';
import { PrivacySection } from '@/components/sharing/privacy-section';
import { LocationSection } from '@/components/sharing/location-section';

export default function PeopleAndSharingScreen() {
  const colors = useColors();
  // Auth is enforced by the `(tabs)` layout — assume a session here.
  const { isLoading: authLoading, user, showBottomSheet } = useOxy();
  const { t } = useTranslation();

  // Get user ID as string
  const userId = typeof user?._id === 'string' ? user._id : undefined;

  const {
    followerCount,
    followingCount,
    blockedCount,
    restrictedCount,
    profileVisibility,
    locationSharing,
    pendingPrivacyKey,
    handlePrivacyUpdate,
    refreshing,
    privacyLoading,
    privacyFetching,
    handleRefresh,
  } = usePrivacyCounts({ userId });

  const {
    contactsPermission,
    isSyncingContacts,
    deviceContactsCount,
    contactMatches,
    handleSyncContacts,
  } = useContactSync();

  // Show loading state
  if (authLoading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.container, styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={[styles.loadingText, { color: colors.text }]}>{t('common.loadingShort')}</Text>
        </View>
      </ScreenContentWrapper>
    );
  }

  return (
    <ScreenContentWrapper refreshing={refreshing || (privacyFetching && !privacyLoading)} onRefresh={handleRefresh}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.mobileContent}>
          <ScreenHeader title={t('sharing.title')} subtitle={t('sharing.subtitle')} />

          <ContactsSection
            userId={userId}
            showBottomSheet={showBottomSheet}
            followerCount={followerCount}
            followingCount={followingCount}
            contactsPermission={contactsPermission}
            isSyncingContacts={isSyncingContacts}
            deviceContactsCount={deviceContactsCount}
            contactMatches={contactMatches}
            onSyncContacts={handleSyncContacts}
          />

          <ProfileVisibilitySection
            showBottomSheet={showBottomSheet}
            profileVisibility={profileVisibility}
            pendingPrivacyKey={pendingPrivacyKey}
            onPrivacyUpdate={handlePrivacyUpdate}
          />

          <PrivacySection
            showBottomSheet={showBottomSheet}
            blockedCount={blockedCount}
            restrictedCount={restrictedCount}
          />

          <LocationSection
            locationSharing={locationSharing}
            pendingPrivacyKey={pendingPrivacyKey}
            onPrivacyUpdate={handlePrivacyUpdate}
          />
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
  mobileContent: {
    padding: 16,
    paddingBottom: 120,
  },
});
