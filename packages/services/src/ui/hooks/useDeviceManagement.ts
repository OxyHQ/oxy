import { useCallback } from 'react';
import type { ApiError } from '@oxy.so/core';
import { DeviceManager } from '@oxy.so/core';
import type { OxyServices } from '@oxy.so/core';
import { handleAuthError } from '../utils/errorHandlers';

export interface UseDeviceManagementOptions {
  oxyServices: OxyServices;
  activeSessionId: string | null;
  onError?: (error: ApiError) => void;
  clearSessionState: () => Promise<void>;
  logger?: (message: string, error?: unknown) => void;
}

export interface UseDeviceManagementResult {
  getDeviceSessions: () => Promise<
    Array<{
      sessionId: string;
      deviceId: string;
      deviceName?: string;
      lastActive?: string;
      expiresAt?: string;
    }>
  >;
  logoutAllDeviceSessions: () => Promise<void>;
  updateDeviceName: (deviceName: string) => Promise<void>;
}

/**
 * Provide device session management helpers tied to the current active session.
 *
 * @param options - Device management configuration
 */
export const useDeviceManagement = ({
  oxyServices,
  activeSessionId,
  onError,
  clearSessionState,
  logger,
}: UseDeviceManagementOptions): UseDeviceManagementResult => {
  const getDeviceSessions = useCallback(async (): Promise<
    Array<{
      sessionId: string;
      deviceId: string;
      deviceName?: string;
      lastActive?: string;
      expiresAt?: string;
    }>
  > => {
    if (!activeSessionId) throw new Error('No active session');
    try {
      return await oxyServices.getDeviceSessions(activeSessionId);
    } catch (error) {
      handleAuthError(error, {
        defaultMessage: 'Failed to get device sessions',
        code: 'GET_DEVICE_SESSIONS_ERROR',
        onError,
        logger,
      });
      throw error instanceof Error ? error : new Error('Failed to get device sessions');
    }
  }, [activeSessionId, logger, onError, oxyServices]);

  const logoutAllDeviceSessions = useCallback(async (): Promise<void> => {
    if (!activeSessionId) throw new Error('No active session');

    try {
      await oxyServices.logoutAllDeviceSessions(activeSessionId);
      await clearSessionState();
    } catch (error) {
      handleAuthError(error, {
        defaultMessage: 'Failed to logout all device sessions',
        code: 'LOGOUT_ALL_DEVICES_ERROR',
        onError,
        logger,
      });
      throw error instanceof Error ? error : new Error('Failed to logout all device sessions');
    }
  }, [activeSessionId, clearSessionState, logger, onError, oxyServices]);

  const updateDeviceName = useCallback(
    async (deviceName: string): Promise<void> => {
      if (!activeSessionId) throw new Error('No active session');

      try {
        await oxyServices.updateDeviceName(activeSessionId, deviceName);
        await DeviceManager.updateDeviceName(deviceName);
      } catch (error) {
        handleAuthError(error, {
          defaultMessage: 'Failed to update device name',
          code: 'UPDATE_DEVICE_NAME_ERROR',
          onError,
          logger,
        });
        throw error instanceof Error ? error : new Error('Failed to update device name');
      }
    },
    [activeSessionId, logger, onError, oxyServices],
  );

  return {
    getDeviceSessions,
    logoutAllDeviceSessions,
    updateDeviceName,
  };
};


