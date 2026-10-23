import { useCallback } from 'react';
import { useApplications } from '@/hooks/use-applications';

/** An application's name from its id, falling back to the id while the list loads. */
export function useApplicationNames(): (applicationId: string) => string {
  const { data: applications = [] } = useApplications();
  return useCallback(
    (applicationId: string) =>
      applications.find((application) => application._id === applicationId)?.name ?? applicationId,
    [applications],
  );
}
