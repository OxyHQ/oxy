import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';
import { useTranslation } from '@/lib/i18n';

interface CameraPermissionSheetProps {
  requestPermission: () => Promise<{ granted: boolean }>;
  refreshPermission: () => Promise<{ granted: boolean }>;
  onGranted: () => void;
  onClose: () => void;
}

/**
 * Camera permission prompt mounted by the ID screen itself. Bloom's native
 * Dialog default is its detached BottomSheet presentation, including the
 * standard declarative action buttons and dismissal lifecycle.
 */
export function CameraPermissionSheet({
  requestPermission,
  refreshPermission,
  onGranted,
  onClose,
}: CameraPermissionSheetProps) {
  const { t } = useTranslation();
  const permissionDialog = useDialogControl();
  const leftForSettingsRef = useRef(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    permissionDialog.open();
  }, [permissionDialog]);

  const closeAndOpenScanner = useCallback(() => {
    permissionDialog.close(onGranted);
  }, [onGranted, permissionDialog]);

  const handleRequestPermission = useCallback(async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      const permission = await requestPermission();
      if (permission.granted) closeAndOpenScanner();
    } finally {
      setRequesting(false);
    }
  }, [closeAndOpenScanner, requestPermission, requesting]);

  const handleOpenSettings = useCallback(() => {
    leftForSettingsRef.current = true;
    const opening =
      Platform.OS === 'ios'
        ? Linking.openURL('app-settings:')
        : Linking.openSettings();
    void opening.catch(() => {
      leftForSettingsRef.current = false;
    });
  }, []);

  // System settings does not update Expo's permission hook by itself. Refresh
  // when the app becomes active again; if access was granted there, close the
  // sheet first and only then enter the full-screen camera route.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (!leftForSettingsRef.current) return;
      leftForSettingsRef.current = false;
      void refreshPermission().then((permission) => {
        if (permission.granted) closeAndOpenScanner();
      });
    });
    return () => subscription.remove();
  }, [closeAndOpenScanner, refreshPermission]);

  return (
    <Dialog
      control={permissionDialog}
      title={t('signInApproval.scan.permissionTitle')}
      description={t('signInApproval.scan.permissionBody')}
      label={t('signInApproval.scan.permissionTitle')}
      onClose={onClose}
      actions={[
        {
          label: t('signInApproval.scan.grantPermission'),
          onPress: () => void handleRequestPermission(),
          shouldCloseOnPress: false,
          loading: requesting,
        },
        {
          label: t('signInApproval.scan.openSettings'),
          onPress: handleOpenSettings,
          shouldCloseOnPress: false,
          disabled: requesting,
        },
        {
          label: t('signInApproval.scan.cancel'),
          color: 'cancel',
          disabled: requesting,
        },
      ]}
    />
  );
}
