import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services';

export interface HomeHandlers {
  handleAvatarPress: () => void;
  handleEditName: () => void;
  handleDevices: () => void;
  handleMenu: () => void;
  handlePersonalInfo: () => void;
  handleDataPrivacy: () => void;
  handleSharing: () => void;
  handleSearch: (query?: string) => void;
  handlePayments: () => void;
  handleStorage: () => void;
  handleFamily: () => void;
  handleSecurity: () => void;
  handleManagedAccounts: () => void;
  handleCreateManagedAccount: () => void;
  handleSetUsername: () => void;
}

/**
 * Centralizes the home screen's navigation / bottom-sheet handlers.
 *
 * These were previously ~16 inline `useCallback`s on the screen, each consumed
 * by one or more of the section item-builders (and a few by the screen's own
 * header / bottom-action buttons). Keeping them in one hook preserves their
 * stable identities (so the downstream `useMemo` item builders don't churn)
 * while letting the item-builder hooks pull only what they need.
 */
export function useHomeHandlers(): HomeHandlers {
  const router = useRouter();
  const { showBottomSheet, openAvatarPicker } = useOxy();

  const handleAvatarPress = useCallback(() => {
    openAvatarPicker();
  }, [openAvatarPicker]);

  const handleEditName = useCallback(() => {
    showBottomSheet?.({
      screen: 'EditProfileField',
      props: { fieldType: 'displayName' }
    });
  }, [showBottomSheet]);

  const handleDevices = useCallback(() => {
    router.push('/(tabs)/devices');
  }, [router]);

  const handleMenu = useCallback(() => {
    showBottomSheet?.('ManageAccount');
  }, [showBottomSheet]);

  const handlePersonalInfo = useCallback(() => {
    router.push('/(tabs)/personal-info');
  }, [router]);

  const handleDataPrivacy = useCallback(() => {
    router.push('/(tabs)/data');
  }, [router]);

  const handleSharing = useCallback(() => {
    router.push('/(tabs)/sharing');
  }, [router]);

  const handleSearch = useCallback((query?: string) => {
    if (query) {
      router.push({ pathname: '/(tabs)/search', params: { q: query } });
    } else {
      router.push('/(tabs)/search');
    }
  }, [router]);

  const handlePayments = useCallback(() => {
    router.push('/(tabs)/payments');
  }, [router]);

  const handleStorage = useCallback(() => {
    router.push('/(tabs)/storage');
  }, [router]);

  const handleFamily = useCallback(() => {
    router.push('/(tabs)/family');
  }, [router]);

  const handleSecurity = useCallback(() => {
    router.push('/(tabs)/security');
  }, [router]);

  const handleManagedAccounts = useCallback(() => {
    router.push('/(tabs)/managed-accounts');
  }, [router]);

  const handleCreateManagedAccount = useCallback(() => {
    showBottomSheet?.('CreateAccount');
  }, [showBottomSheet]);

  const handleSetUsername = useCallback(() => {
    showBottomSheet?.({
      screen: 'EditProfileField',
      props: { fieldType: 'username' }
    });
  }, [showBottomSheet]);

  return {
    handleAvatarPress,
    handleEditName,
    handleDevices,
    handleMenu,
    handlePersonalInfo,
    handleDataPrivacy,
    handleSharing,
    handleSearch,
    handlePayments,
    handleStorage,
    handleFamily,
    handleSecurity,
    handleManagedAccounts,
    handleCreateManagedAccount,
    handleSetUsername,
  };
}
