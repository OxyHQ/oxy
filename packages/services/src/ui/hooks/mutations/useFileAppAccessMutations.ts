import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authenticatedApiCall } from '@oxy.so/core';
import type { FileApplicationAccessRevocation } from '@oxy.so/core';
import { queryKeys } from '../queries/queryKeys';
import { mutationKeys } from './mutationKeys';
import { useOxy } from '../../context/oxyRuntimeContext';
import { removeAppAccessFromCache } from '../queries/useFileQueries';

/**
 * Take an application's access to one of the person's files away (ADR 0043
 * stage 4c): optimistic — the application leaves the cached list at once and
 * comes back if the revoke fails — then the list is re-read either way. The
 * caller shows its own toasts (it knows the application's name).
 *
 * It belongs with the file family's reads (`useFileAppAccess`), whose cache it
 * edits, and moves to bloom-data with them.
 */
export const useRevokeFileAppAccess = () => {
  const { oxyServices, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.fileAppAccess.revoke],
    mutationFn: async ({ fileId, applicationId }: { fileId: string; applicationId: string }) =>
      authenticatedApiCall<FileApplicationAccessRevocation>(oxyServices, activeSessionId, () =>
        oxyServices.assets.revokeAppAccess(fileId, applicationId),
      ),
    onMutate: async ({ fileId, applicationId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.files.appAccess(fileId) });
      return { previous: removeAppAccessFromCache(queryClient, fileId, applicationId) };
    },
    onError: (_error, { fileId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.files.appAccess(fileId), context.previous);
      }
    },
    onSettled: (_data, _error, { fileId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.files.appAccess(fileId) });
    },
  });
};
