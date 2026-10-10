import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { getDeviceIcon, groupDevicesByType, type DeviceRecord } from '@/utils/device-utils';
import type { GroupedItem } from '@/components/sections/types';

interface UseDeviceItemsArgs {
  devices: DeviceRecord[];
}

/**
 * Builds the device `GroupedSection` rows for the security screen, grouped by
 * device type. Each row shows the count and a preview of up to three device
 * names, and navigates to the devices list on tap.
 *
 * The grouping algorithm lives in `groupDevicesByType` (device-utils); this
 * hook maps the resulting groups to rendered rows. Extracted verbatim from the
 * security screen's inline `useMemo`.
 */
export function useDeviceItems({ devices }: UseDeviceItemsArgs): GroupedItem[] {
  const colors = useColors();
  const router = useRouter();
  const { t } = useTranslation();

  return useMemo(() => {
    if (!devices || devices.length === 0) return [];

    return groupDevicesByType(devices, 'Unknown Device').map((group) => {
      const icon = getDeviceIcon(group.type);
      const typeLabel = group.type.charAt(0).toUpperCase() + group.type.slice(1);
      const subtitle =
        group.names.length > 0
          ? group.names.join(', ') + (group.count > group.names.length ? '...' : '')
          : `${group.count} device(s)`;

      return {
        id: `device-${group.type}`,
        icon,
        iconColor: colors.sidebarIconDevices,
        title: t('security.devices.groupTitle', { count: group.count, type: typeLabel }),
        subtitle,
        onPress: () => router.push('/(tabs)/devices'),
        showChevron: true,
      };
    });
  }, [devices, colors, router, t]);
}
