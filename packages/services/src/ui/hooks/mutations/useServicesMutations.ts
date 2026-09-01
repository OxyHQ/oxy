import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClientSession } from '@oxyhq/core';
import { queryKeys, invalidateSessionQueries } from '../queries/queryKeys';
import { mutationKeys } from './mutationKeys';
import { useOxy } from '../../context/OxyContext';
import { toast } from '@oxyhq/bloom/toast';

/**
 * Switch active session
 */
export const useSwitchSession = () => {
  const { switchSession } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.session.switch],
    mutationFn: async (sessionId: string) => {
      return await switchSession(sessionId);
    },
    onSuccess: (user, sessionId) => {
      // Invalidate all session queries
      invalidateSessionQueries(queryClient);
      
      // Update current user query
      queryClient.setQueryData(queryKeys.accounts.current(sessionId), user);
      
      // Invalidate account queries
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to switch session');
    },
  });
};

/**
 * Logout from a session
 */
export const useLogoutSession = () => {
  const { oxyServices, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.session.logout],
    mutationFn: async (targetSessionId?: string) => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }
      
      const sessionToLogout = targetSessionId || activeSessionId;
      await oxyServices.logoutSession(activeSessionId, sessionToLogout);
      
      return sessionToLogout;
    },
    onMutate: async (targetSessionId) => {
      // Cancel outgoing queries
      await queryClient.cancelQueries({ queryKey: queryKeys.sessions.all });
      
      // Snapshot previous sessions
      const previousSessions = queryClient.getQueryData(queryKeys.sessions.list());
      
      // Optimistically remove session
      if (previousSessions) {
        const sessionToLogout = targetSessionId || activeSessionId;
        const updatedSessions = (previousSessions as ClientSession[]).filter(
          (s) => s.sessionId !== sessionToLogout
        );
        queryClient.setQueryData(queryKeys.sessions.list(), updatedSessions);
      }
      
      return { previousSessions };
    },
    onError: (error, targetSessionId, context) => {
      // Rollback on error
      if (context?.previousSessions) {
        queryClient.setQueryData(queryKeys.sessions.list(), context.previousSessions);
      }
      toast.error(error instanceof Error ? error.message : 'Failed to logout');
    },
    onSuccess: () => {
      // Invalidate all session queries
      invalidateSessionQueries(queryClient);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    },
  });
};

/**
 * Logout from all sessions
 */
export const useLogoutAll = () => {
  const { oxyServices, activeSessionId, clearSessionState } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.session.logoutAll],
    mutationFn: async () => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }
      
      await oxyServices.logoutAllSessions(activeSessionId);
      await clearSessionState();
    },
    onSuccess: () => {
      // Clear all queries
      queryClient.clear();
      toast.success('Logged out from all sessions');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to logout from all sessions');
    },
  });
};

/**
 * Update device name
 */
export const useUpdateDeviceName = () => {
  const { oxyServices, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.session.updateDeviceName],
    mutationFn: async (deviceName: string) => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }
      
      return await oxyServices.updateDeviceName(activeSessionId, deviceName);
    },
    onSuccess: () => {
      // Invalidate device and session queries
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      toast.success('Device name updated');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update device name');
    },
  });
};

/**
 * Remove a device
 */
export const useRemoveDevice = () => {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.session.removeDevice],
    mutationFn: async (deviceId: string) => {
      await oxyServices.removeDevice(deviceId);
      return deviceId;
    },
    onSuccess: () => {
      // Invalidate device queries
      queryClient.invalidateQueries({ queryKey: queryKeys.devices.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      toast.success('Device removed');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to remove device');
    },
  });
};

