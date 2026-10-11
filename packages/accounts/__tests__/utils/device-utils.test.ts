import {
  getDeviceIcon,
  getDeviceDisplayName,
  groupDevicesByType,
  MAX_DEVICE_GROUP_NAME_PREVIEW,
  type DeviceRecord,
} from '@/utils/device-utils';

describe('getDeviceIcon', () => {
  it('returns the generic devices glyph when no type is given', () => {
    expect(getDeviceIcon()).toBe('devices');
    expect(getDeviceIcon('')).toBe('devices');
  });

  it('maps phone-like types to cellphone (case-insensitive, substring)', () => {
    expect(getDeviceIcon('iPhone')).toBe('cellphone');
    expect(getDeviceIcon('Android')).toBe('cellphone');
    expect(getDeviceIcon('mobile')).toBe('cellphone');
    expect(getDeviceIcon('Some Phone')).toBe('cellphone');
  });

  it('maps tablet-like types to tablet', () => {
    expect(getDeviceIcon('iPad')).toBe('tablet');
    expect(getDeviceIcon('tablet')).toBe('tablet');
  });

  it('prioritizes the phone match when a type contains both phone and tablet hints', () => {
    // Matching is ordered: the phone/android check runs before the tablet
    // check, so "Android Tablet" resolves to cellphone. This pins the
    // existing precedence of the shared helper.
    expect(getDeviceIcon('Android Tablet')).toBe('cellphone');
  });

  it('maps desktop-class types to laptop', () => {
    expect(getDeviceIcon('MacBook')).toBe('laptop');
    expect(getDeviceIcon('Windows')).toBe('laptop');
    expect(getDeviceIcon('linux')).toBe('laptop');
    expect(getDeviceIcon('desktop')).toBe('laptop');
  });

  it('falls back to devices for unknown types', () => {
    expect(getDeviceIcon('toaster')).toBe('devices');
  });
});

describe('getDeviceDisplayName', () => {
  it('prefers name, then deviceName, then the fallback', () => {
    expect(getDeviceDisplayName({ name: 'A', deviceName: 'B' }, 'F')).toBe('A');
    expect(getDeviceDisplayName({ deviceName: 'B' }, 'F')).toBe('B');
    expect(getDeviceDisplayName({}, 'F')).toBe('F');
  });
});

describe('groupDevicesByType', () => {
  it('returns an empty array for no devices', () => {
    expect(groupDevicesByType([], 'Unknown')).toEqual([]);
  });

  it('groups by normalized type and counts each group', () => {
    const devices: DeviceRecord[] = [
      { id: '1', type: 'mobile', name: 'Phone A' },
      { id: '2', type: 'mobile', name: 'Phone B' },
      { id: '3', type: 'desktop', name: 'Mac' },
    ];

    const groups = groupDevicesByType(devices, 'Unknown');

    expect(groups).toHaveLength(2);
    const mobile = groups.find((g) => g.type === 'mobile');
    const desktop = groups.find((g) => g.type === 'desktop');
    expect(mobile?.count).toBe(2);
    expect(desktop?.count).toBe(1);
  });

  it('coalesces the type field variants and defaults to "unknown"', () => {
    const devices: DeviceRecord[] = [{ id: '1', deviceType: 'tablet' }, { id: '2' }];

    const groups = groupDevicesByType(devices, 'Unknown');

    expect(groups.map((g) => g.type).sort()).toEqual(['tablet', 'unknown']);
  });

  it('preserves first-seen group order', () => {
    const devices: DeviceRecord[] = [
      { id: '1', type: 'desktop' },
      { id: '2', type: 'mobile' },
      { id: '3', type: 'desktop' },
    ];

    const groups = groupDevicesByType(devices, 'Unknown');

    expect(groups.map((g) => g.type)).toEqual(['desktop', 'mobile']);
  });

  it('caps the preview names at MAX_DEVICE_GROUP_NAME_PREVIEW but keeps the full count', () => {
    const devices: DeviceRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      type: 'mobile',
      name: `Phone ${i}`,
    }));

    const [group] = groupDevicesByType(devices, 'Unknown');

    expect(group.count).toBe(5);
    expect(group.names).toHaveLength(MAX_DEVICE_GROUP_NAME_PREVIEW);
    expect(group.names).toEqual(['Phone 0', 'Phone 1', 'Phone 2']);
  });

  it('falls back to the provided name fallback for records missing a name', () => {
    const devices: DeviceRecord[] = [{ deviceId: 'd1', type: 'mobile' }, { type: 'mobile' }];

    const [group] = groupDevicesByType(devices, 'Unknown Device');

    expect(group.names).toEqual(['Unknown Device', 'Unknown Device']);
  });
});
