import React, { useMemo, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { AccountCard, ScreenHeader } from '@/components/ui';
import { ScreenContentWrapper } from '@/components/screen-content-wrapper';
import { useOxy } from '@oxyhq/services';
import { formatDate } from '@/utils/date-utils';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { AccountInfoGrid, type AccountInfoCard } from '@/components/account-info-grid';
import { Section } from '@/components/section';
import { GroupedSection } from '@/components/grouped-section';
import type { ExtendedUser } from '@/types/user';
import { useTranslation } from '@/lib/i18n';

export default function PersonalInfoScreen() {
  const colors = useColors();
  const { t } = useTranslation();

  // OxyServices integration — auth is enforced by the `(tabs)` layout.
  // This screen views/edits the current account's profile. Switching accounts
  // is a real session switch, so all identity fields read from `user` (the
  // switched-into account). Edits flow through the bottom sheet, which targets
  // the current account.
  const { user, isLoading: oxyLoading, showBottomSheet } = useOxy();
  const handlePressIn = useHapticPress();
  const handleEditField = useCallback((field: string) => {
    showBottomSheet?.({
      screen: 'EditProfileField',
      props: { fieldType: field }
    });
  }, [showBottomSheet]);

  // Compute current-account profile data.
  const displayName = useMemo(
    () => user?.name?.displayName ?? getNormalizedUserHandle(user) ?? '',
    [user],
  );
  const userUsername = useMemo(() => user?.username ?? null, [user?.username]);
  const userEmail = useMemo(() => user?.email ?? t('personalInfo.fields.noEmail'), [user?.email, t]);
  const extendedUser = user as ExtendedUser | undefined;
  const userPhone = useMemo(() => extendedUser?.phone ?? null, [extendedUser]);
  const userAddress = useMemo(() => extendedUser?.address ?? null, [extendedUser]);
  const userBirthday = useMemo(() => {
    const birthday = extendedUser?.birthday ?? extendedUser?.dateOfBirth;
    return birthday ? formatDate(birthday) : null;
  }, [extendedUser]);

  const personalInfoCards = useMemo<AccountInfoCard[]>(() => [
    {
      id: 'name',
      icon: 'account-outline',
      iconColor: colors.sidebarIconPersonalInfo,
      title: t('personalInfo.fields.fullName'),
      value: displayName ?? t('common.notSet'),
      onPress: () => handleEditField('displayName'),
    },
    {
      id: 'username',
      icon: 'at',
      iconColor: colors.sidebarIconPersonalInfo,
      title: t('personalInfo.fields.username'),
      value: userUsername ? `@${userUsername}` : t('common.notSet'),
      onPress: () => handleEditField('username'),
    },
    {
      id: 'email',
      icon: 'email-outline',
      iconColor: colors.sidebarIconSecurity,
      title: t('personalInfo.fields.email'),
      value: userEmail,
      onPress: () => handleEditField('email'),
    },
    {
      id: 'phone',
      icon: 'phone-outline',
      iconColor: colors.sidebarIconPersonalInfo,
      title: t('personalInfo.fields.phone'),
      value: userPhone ?? t('common.notSet'),
      onPress: () => handleEditField('phone'),
    },
    {
      id: 'address',
      icon: 'map-marker-outline',
      iconColor: colors.sidebarIconData,
      title: t('personalInfo.fields.address'),
      value: userAddress ?? t('common.notSet'),
      onPress: () => handleEditField('address'),
    },
    {
      id: 'birthday',
      icon: 'calendar-star',
      iconColor: colors.sidebarIconFamily,
      title: t('personalInfo.fields.birthday'),
      value: userBirthday ?? t('common.notSet'),
      onPress: () => handleEditField('birthday'),
    },
    {
      id: 'created',
      icon: 'calendar-outline',
      iconColor: colors.sidebarIconData,
      title: t('personalInfo.fields.accountCreated'),
      value: user?.createdAt ? formatDate(user.createdAt) : t('common.unknown'),
    },
  ], [colors.sidebarIconPersonalInfo, colors.sidebarIconSecurity, colors.sidebarIconData, colors.sidebarIconFamily, displayName, userUsername, userEmail, userPhone, userAddress, userBirthday, user?.createdAt, handleEditField, t]);

  const contactItems = useMemo(() => [
    {
      id: 'email',
      icon: 'email-outline',
      iconColor: colors.sidebarIconSecurity,
      title: t('personalInfo.fields.email'),
      subtitle: userEmail,
      showChevron: false,
      onPress: () => handleEditField('email'),
    },
    {
      id: 'phone',
      icon: 'phone-outline',
      iconColor: colors.sidebarIconPersonalInfo,
      title: t('personalInfo.fields.phone'),
      subtitle: userPhone ?? t('common.notSet'),
      showChevron: false,
      onPress: () => handleEditField('phone'),
    },
    {
      id: 'address',
      icon: 'map-marker-outline',
      iconColor: colors.sidebarIconData,
      title: t('personalInfo.fields.address'),
      subtitle: userAddress ?? t('common.notSet'),
      showChevron: false,
      onPress: () => handleEditField('address'),
    },
    {
      id: 'birthday',
      icon: 'calendar-star',
      iconColor: colors.sidebarIconFamily,
      title: t('personalInfo.fields.birthday'),
      subtitle: userBirthday ?? t('common.notSet'),
      showChevron: false,
      onPress: () => handleEditField('birthday'),
    },
  ], [colors.sidebarIconSecurity, colors.sidebarIconPersonalInfo, colors.sidebarIconData, colors.sidebarIconFamily, userEmail, userPhone, userAddress, userBirthday, handleEditField, t]);

  const actionsItems = useMemo(() => [
    {
      id: 'edit-profile',
      icon: 'account-edit-outline',
      iconColor: colors.sidebarIconPersonalInfo,
      title: t('personalInfo.actions.editProfile'),
      subtitle: t('personalInfo.actions.editProfileSubtitle'),
      onPress: () => showBottomSheet?.({ screen: 'EditProfile' }),
      showChevron: true,
    },
    {
      id: 'manage-sessions',
      icon: 'monitor-lock',
      iconColor: colors.sidebarIconSecurity,
      title: t('personalInfo.actions.manageSessions'),
      subtitle: t('personalInfo.actions.manageSessionsSubtitle'),
      onPress: () => showBottomSheet?.('ManageAccount'),
      showChevron: true,
    },
    {
      id: 'subscription',
      icon: 'credit-card-outline',
      iconColor: colors.sidebarIconPayments,
      title: t('personalInfo.actions.subscription'),
      subtitle: t('personalInfo.actions.subscriptionSubtitle'),
      onPress: () => showBottomSheet?.('PremiumSubscription'),
      showChevron: true,
    },
    {
      id: 'account-overview',
      icon: 'shield-key',
      iconColor: colors.sidebarIconSecurity,
      title: t('personalInfo.actions.identitySecurity'),
      subtitle: t('personalInfo.actions.identitySecuritySubtitle'),
      onPress: () => showBottomSheet?.('ManageAccount'),
      showChevron: true,
    },
  ], [colors.sidebarIconPersonalInfo, colors.sidebarIconSecurity, colors.sidebarIconPayments, showBottomSheet, t]);

  // Show loading state while OxyServices is initializing
  if (oxyLoading) {
    return (
      <ScreenContentWrapper>
        <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.tint} />
          <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('common.loadingShort')}</ThemedText>
        </View>
      </ScreenContentWrapper>
    );
  }

  return (
    <ScreenContentWrapper>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.content}>
          <ScreenHeader title={t('personalInfo.title')} subtitle={t('personalInfo.subtitle')} />
          <Section title={t('personalInfo.sections.profileSummary')}>
            <AccountInfoGrid cards={personalInfoCards} onPressIn={handlePressIn} />
          </Section>
          <Section title={t('personalInfo.sections.contactDetails')}>
            <AccountCard>
              <GroupedSection items={contactItems} />
            </AccountCard>
          </Section>
          <Section title={t('personalInfo.sections.actions')}>
            <AccountCard>
              <GroupedSection items={actionsItems} />
            </AccountCard>
          </Section>
        </View>
      </View>
    </ScreenContentWrapper>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    opacity: 0.7,
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  placeholderText: {
    fontSize: 16,
    textAlign: 'center',
  },
});

