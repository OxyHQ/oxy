import { Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';

/**
 * Whether the signed-in account's encrypted backup is OWED on this device
 * (round-5 review R5-9): a key rotation deleted the previous backup with the
 * swap and no new one has been sealed yet — the upload failed, or the app
 * stopped between the swap and the re-seal. Until one is, the keys the old
 * backup carried live only on this phone, so Commons keeps asking.
 *
 * `oxy.identity.backup.isOwed()` reads a flag core sets before the swap and
 * clears once `backup.create` succeeds. Never for a person who deleted their
 * backup and did not choose one again (owner's decision, 2026-11-07): core
 * drops that entry against the account's status. Invalidate
 * {@link BACKUP_OWED_QUERY_KEY} after creating a backup or rotating.
 */
export const BACKUP_OWED_QUERY_KEY = ['identity', 'backup-owed'] as const;

export function useBackupOwed(): boolean {
  const { oxyServices, isAuthenticated } = useOxy();
  const query = useQuery({
    queryKey: BACKUP_OWED_QUERY_KEY,
    queryFn: async () => (oxyServices ? oxyServices.identity.backup.isOwed() : false),
    enabled: Platform.OS !== 'web' && Boolean(oxyServices && isAuthenticated),
    staleTime: 0,
    retry: false,
  });
  return query.data === true;
}
