import { useMemo } from 'react';
import { useEntities } from '@oxy.so/bloom-data';
import type { SecurityActivity } from '@oxy.so/core';
import { Device, SecurityEvent, useRecentSecurityActivity, useUserDevices } from '@oxy.so/services';
import type { DeviceRecord } from '@/utils/device-utils';

/**
 * The SDK's list hooks name rows by id; these read the rows a screen renders
 * from the account's store, with the list's state beside them.
 */
function present<T>(rows: readonly (T | undefined)[]): T[] {
  return rows.filter((row): row is T => row !== undefined);
}

/** The account's devices. */
export function useDeviceRecords() {
  const view = useUserDevices();
  const rows = useEntities(Device, view.ids);
  const devices = useMemo(() => present(rows) as DeviceRecord[], [rows]);
  return { ...view, devices };
}

/** The account's latest security events, newest first. */
export function useRecentSecurityEvents(limit: number) {
  const view = useRecentSecurityActivity(limit);
  const rows = useEntities(SecurityEvent, view.ids);
  const events = useMemo(() => present(rows) as SecurityActivity[], [rows]);
  return { ...view, events };
}
