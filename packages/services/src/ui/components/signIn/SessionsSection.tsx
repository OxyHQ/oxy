/**
 * "Where you're signed in": the signed-in account's sessions on every device,
 * from the server (`oxy.devices.sessions`). Removing one ends that session;
 * "Sign out of all other devices" ends every session but this one
 * (`oxy.devices.logoutAll`) — it never signs this device out.
 */

import type React from 'react';
import { useCallback, useState } from 'react';
import { useAction, useEntity } from '@oxy.so/bloom-data';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { logger as loggerUtil, type DeviceLinkedSession } from '@oxy.so/core';
import { useOxy } from '../../context/oxyRuntimeContext';
import { DeviceSession, logoutSessionAction } from '../../data/sessions';
import { useDeviceSessions } from '../../hooks/queries/useServicesQueries';
import { useI18n } from '../../hooks/useI18n';
import Ionicons from '../../icons/Ionicons';
import { deviceSessionTitle } from '../../utils/deviceSessionTitle';
import { SettingsIcon } from '../SettingsIcon';

const formatRelative = (dateString?: string): string => {
  if (!dateString) {
    return '—';
  }
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absMin = Math.abs(diffMs) / 60000;
  const isFuture = diffMs > 0;
  if (absMin < 1) {
    return isFuture ? 'in moments' : 'just now';
  }
  if (absMin < 60) {
    const v = Math.floor(absMin);
    return isFuture ? `in ${v}m` : `${v}m ago`;
  }
  const hrs = absMin / 60;
  if (hrs < 24) {
    const v = Math.floor(hrs);
    return isFuture ? `in ${v}h` : `${v}h ago`;
  }
  const days = hrs / 24;
  if (days < 7) {
    const v = Math.floor(days);
    return isFuture ? `in ${v}d` : `${v}d ago`;
  }
  return date.toLocaleDateString();
};

export const SessionsSection: React.FC = () => {
  const bloomTheme = useTheme();
  const { t } = useI18n();
  const { isAuthenticated, oxyServices, activeSessionId } = useOxy();
  const {
    ids: deviceIds,
    extra: deviceSessionsExtra,
    isLoading: deviceSessionsLoading,
    refresh: refetchDeviceSessions,
  } = useDeviceSessions({ enabled: isAuthenticated && !!activeSessionId });

  const endSession = useAction(logoutSessionAction).run;
  const [removingDeviceId, setRemovingDeviceId] = useState<string | null>(null);
  const [signingOutAllDevices, setSigningOutAllDevices] = useState(false);

  const current = deviceSessionsExtra?.current ?? [];
  const otherDevices = deviceIds.filter((id) => !current.includes(id));

  const confirmRemoveDevice = useCallback(
    async (device: DeviceLinkedSession) => {
      if (!activeSessionId) {
        return;
      }
      const confirmed = await surfaces.confirm({
        title: t('manageAccount.confirms.removeDeviceTitle') || 'Remove device',
        description: t('manageAccount.confirms.removeDevice', {
          name: deviceSessionTitle(device, t),
        }),
        confirmLabel: t('common.remove') || 'Remove',
        cancelLabel: t('common.cancel') || 'Cancel',
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      // Named now: the row (and, once the server agrees, its record) goes at once.
      const name = deviceSessionTitle(device, t);
      setRemovingDeviceId(device.sessionId);
      try {
        // The row hides at once, returns if the server refuses, and the
        // account's session lists are read again once it agrees.
        await endSession(oxyServices, activeSessionId, device.sessionId);
        toast.success(t('manageAccount.toasts.deviceRemoved', { name }));
      } catch (error) {
        loggerUtil.warn('Remove device failed', { component: 'SessionsSection' }, error as unknown);
        toast.error(t('manageAccount.toasts.deviceRemoveFailed') || 'Failed to remove device');
      } finally {
        setRemovingDeviceId(null);
      }
    },
    [activeSessionId, endSession, oxyServices, t],
  );

  const handleSignOutAllDevices = useCallback(async () => {
    if (!activeSessionId || signingOutAllDevices) {
      return;
    }
    const confirmed = await surfaces.confirm({
      title: t('manageAccount.confirms.signOutAllDevicesTitle') || 'Sign out of all other devices',
      description:
        t('manageAccount.confirms.signOutAllDevices', { count: otherDevices.length }) ||
        `End ${otherDevices.length} other device session(s)? This won't sign you out here.`,
      confirmLabel: t('common.actions.signOut') || 'Sign out',
      cancelLabel: t('common.cancel') || 'Cancel',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    setSigningOutAllDevices(true);
    try {
      await oxyServices.devices.logoutAll(activeSessionId);
      await refetchDeviceSessions();
      toast.success(
        t('manageAccount.toasts.allDevicesSignedOut') || 'Signed out from all other devices',
      );
    } catch (error) {
      loggerUtil.warn(
        'Sign out all devices failed',
        { component: 'SessionsSection' },
        error as unknown,
      );
      toast.error(
        t('manageAccount.toasts.allDevicesFailed') || 'Failed to sign out from other devices',
      );
    } finally {
      setSigningOutAllDevices(false);
    }
  }, [
    activeSessionId,
    signingOutAllDevices,
    otherDevices.length,
    oxyServices,
    refetchDeviceSessions,
    t,
  ]);

  return (
    <GroupedSection title={t('manageAccount.sections.sessions') || 'Sessions & devices'}>
      {deviceSessionsLoading ? (
        <GroupedSectionItem
          icon={<SettingsIcon name="sync" color={bloomTheme.colors.primary} />}
          title={t('manageAccount.sessions.loading') || 'Loading sessions…'}
          rightElement={null}
          showChevron={false}
          disabled
        />
      ) : deviceIds.length === 0 ? (
        <GroupedSectionItem
          icon={<SettingsIcon name="cellphone" color={bloomTheme.colors.textTertiary} />}
          title={t('manageAccount.sessions.empty') || 'No active sessions'}
          showChevron={false}
          disabled
        />
      ) : (
        deviceIds.map((id) => (
          <DeviceSessionRow
            key={`device-${id}`}
            id={id}
            removing={removingDeviceId === id}
            onRemove={confirmRemoveDevice}
          />
        ))
      )}
      {otherDevices.length > 0 ? (
        <GroupedSectionItem
          icon={<SettingsIcon name="logout" color={bloomTheme.colors.error} />}
          title={
            t('manageAccount.sessions.signOutAllOnThisDevice') || 'Sign out of all other devices'
          }
          description={
            t('manageAccount.sessions.signOutAllSubtitle', {
              count: otherDevices.length,
            }) || `End ${otherDevices.length} other device session(s)`
          }
          onPress={handleSignOutAllDevices}
          destructive
          showChevron={false}
          disabled={signingOutAllDevices}
          rightElement={
            signingOutAllDevices ? (
              <SpinnerIcon color={bloomTheme.colors.error} size={16} />
            ) : undefined
          }
        />
      ) : null}
    </GroupedSection>
  );
};

interface DeviceSessionRowProps {
  id: string;
  removing: boolean;
  onRemove: (device: DeviceLinkedSession) => void;
}

/** One session on this device, read from `DeviceSession`. */
const DeviceSessionRow: React.FC<DeviceSessionRowProps> = ({ id, removing, onRemove }) => {
  const bloomTheme = useTheme();
  const { t } = useI18n();
  const device = useEntity(DeviceSession, id);
  if (!device) return null;
  return (
    <GroupedSectionItem
      icon={
        <SettingsIcon
          name={device.isCurrent ? 'cellphone' : 'cellphone-basic'}
          color={device.isCurrent ? bloomTheme.colors.success : bloomTheme.colors.primary}
        />
      }
      title={deviceSessionTitle(device, t)}
      description={
        t('manageAccount.sessions.lastActive', {
          relative: formatRelative(device.lastActive),
        }) || `Last active ${formatRelative(device.lastActive)}`
      }
      onPress={device.isCurrent ? undefined : () => onRemove(device)}
      disabled={device.isCurrent || removing}
      rightElement={
        !device.isCurrent ? (
          removing ? (
            <SpinnerIcon color={bloomTheme.colors.error} size={16} />
          ) : (
            <Ionicons name="log-out-outline" size={18} color={bloomTheme.colors.error} />
          )
        ) : undefined
      }
      showChevron={false}
    />
  );
};
