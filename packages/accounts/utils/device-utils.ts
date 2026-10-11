/**
 * Shared device helpers for the accounts app.
 *
 * Consolidates the `getDeviceIcon` implementation (previously copy-pasted into
 * the security, devices list, and device-detail screens with a `monitor` vs
 * `laptop` inconsistency) and the `DeviceRecord` shape (previously redeclared
 * three times). Desktop-class devices now resolve to `laptop` everywhere,
 * matching the dedicated device-management screens.
 */

import type { MaterialCommunityIconName } from '@/types/icons';

/**
 * Normalized device record returned by the devices API. Fields are optional
 * because the backend payload has evolved over time (`name` vs `deviceName`,
 * `id` vs `deviceId`, etc.); callers coalesce the variants.
 */
export interface DeviceRecord {
  id?: string;
  deviceId?: string;
  name?: string;
  deviceName?: string;
  type?: string;
  deviceType?: string;
  lastActive?: string;
  createdAt?: string;
  isCurrent?: boolean;
}

/**
 * Maps a device-type string to a MaterialCommunityIcons glyph name.
 *
 * Matching is substring-based and case-insensitive so values like
 * `"iPhone"`, `"Android Tablet"`, or `"MacBook"` resolve correctly.
 */
export function getDeviceIcon(deviceType?: string): MaterialCommunityIconName {
  if (!deviceType) return 'devices';
  const type = deviceType.toLowerCase();

  if (
    type.includes('mobile') ||
    type.includes('phone') ||
    type.includes('iphone') ||
    type.includes('android')
  ) {
    return 'cellphone';
  }
  if (type.includes('tablet') || type.includes('ipad')) {
    return 'tablet';
  }
  if (
    type.includes('desktop') ||
    type.includes('laptop') ||
    type.includes('mac') ||
    type.includes('windows') ||
    type.includes('linux')
  ) {
    return 'laptop';
  }
  return 'devices';
}

/**
 * Resolves a human-friendly device name, coalescing the `name`/`deviceName`
 * payload variants and falling back to a caller-provided default.
 */
export function getDeviceDisplayName(device: DeviceRecord, fallback: string): string {
  return device.name || device.deviceName || fallback;
}

/** Maximum number of device names previewed per group. */
export const MAX_DEVICE_GROUP_NAME_PREVIEW = 3;

/** A set of devices that share the same normalized `type`. */
export interface DeviceGroup {
  /** Normalized device type (`device.type ?? device.deviceType ?? 'unknown'`). */
  type: string;
  /** Total number of devices of this type. */
  count: number;
  /** Up to {@link MAX_DEVICE_GROUP_NAME_PREVIEW} display names for preview. */
  names: string[];
}

/**
 * Groups devices by their normalized type, preserving first-seen order.
 *
 * Pure helper backing the security screen's device section: it counts devices
 * per type and collects a capped preview of display names. Extracted from the
 * screen so the grouping algorithm can be unit tested without standing up the
 * React/RN render tree.
 *
 * @param devices - The device records to group.
 * @param nameFallback - Display-name fallback for records missing a name.
 */
export function groupDevicesByType(devices: DeviceRecord[], nameFallback: string): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>();

  devices.forEach((device) => {
    const type = device.type || device.deviceType || 'unknown';
    const name = getDeviceDisplayName(device, nameFallback);

    let group = groups.get(type);
    if (!group) {
      group = { type, count: 0, names: [] };
      groups.set(type, group);
    }
    group.count++;
    if (group.names.length < MAX_DEVICE_GROUP_NAME_PREVIEW) {
      group.names.push(name);
    }
  });

  return Array.from(groups.values());
}
