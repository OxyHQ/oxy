import type { SecurityActivity, SecurityEventType } from '@oxy.so/core';
import {
  formatEventDescription,
  getEventIcon,
  getEventSeverity,
  getSeverityColor,
} from '@/utils/security-utils';

const allEventTypes: SecurityEventType[] = [
  'sign_in',
  'sign_out',
  'profile_updated',
  'email_changed',
  'device_added',
  'device_removed',
  'security_settings_changed',
  'account_recovery',
  'private_key_exported',
  'backup_created',
  'suspicious_activity',
];

function activity(
  eventType: SecurityEventType,
  eventDescription = 'Default',
  metadata?: SecurityActivity['metadata'],
): SecurityActivity {
  const now = new Date().toISOString();
  return {
    id: 'evt_1',
    userId: 'u1',
    eventType,
    eventDescription,
    severity: 'low',
    timestamp: now,
    createdAt: now,
    metadata,
  };
}

describe('getEventIcon', () => {
  it('returns a non-empty icon name for every supported event type', () => {
    for (const eventType of allEventTypes) {
      expect(getEventIcon(eventType).length).toBeGreaterThan(0);
    }
  });

  it('returns the dedicated login icon for sign_in', () => {
    expect(getEventIcon('sign_in')).toBe('login');
  });

  it('returns the alert icon for suspicious_activity', () => {
    expect(getEventIcon('suspicious_activity')).toBe('alert-circle');
  });

  it('returns the default shield icon for unknown event types', () => {
    expect(getEventIcon('totally_unknown' as SecurityEventType)).toBe('shield-check');
  });
});

describe('getSeverityColor', () => {
  it('returns distinct colours per severity in light mode', () => {
    const low = getSeverityColor('low', 'light');
    const medium = getSeverityColor('medium', 'light');
    const high = getSeverityColor('high', 'light');
    const critical = getSeverityColor('critical', 'light');
    const palette = new Set([low, medium, high, critical]);
    expect(palette.size).toBe(4);
  });

  it('returns distinct colours per severity in dark mode', () => {
    const low = getSeverityColor('low', 'dark');
    const medium = getSeverityColor('medium', 'dark');
    const high = getSeverityColor('high', 'dark');
    const critical = getSeverityColor('critical', 'dark');
    const palette = new Set([low, medium, high, critical]);
    expect(palette.size).toBe(4);
  });

  it('light and dark "low" colours differ', () => {
    expect(getSeverityColor('low', 'light')).not.toBe(getSeverityColor('low', 'dark'));
  });

  it('returns a hex colour string', () => {
    expect(getSeverityColor('low', 'light')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('getEventSeverity', () => {
  it('returns "low" for sign_in', () => {
    expect(getEventSeverity('sign_in')).toBe('low');
  });

  it('returns "medium" for email_changed', () => {
    expect(getEventSeverity('email_changed')).toBe('medium');
  });

  it('returns "high" for account_recovery', () => {
    expect(getEventSeverity('account_recovery')).toBe('high');
  });

  it('returns "critical" for suspicious_activity', () => {
    expect(getEventSeverity('suspicious_activity')).toBe('critical');
  });

  it('defaults to "low" for unknown event types', () => {
    expect(getEventSeverity('totally_unknown' as SecurityEventType)).toBe('low');
  });
});

describe('formatEventDescription', () => {
  it('returns the bare description when no relevant metadata is present', () => {
    expect(formatEventDescription(activity('sign_in', 'Signed in from web'))).toBe(
      'Signed in from web',
    );
  });

  it('appends device name for device_added events', () => {
    const result = formatEventDescription(
      activity('device_added', 'New device', { deviceName: "Nate's iPhone" }),
    );
    expect(result).toBe("New device (Nate's iPhone)");
  });

  it('appends device name for device_removed events', () => {
    const result = formatEventDescription(
      activity('device_removed', 'Device removed', { deviceName: 'Old iPad' }),
    );
    expect(result).toBe('Device removed (Old iPad)');
  });

  it('renders email change with old and new values', () => {
    const result = formatEventDescription(
      activity('email_changed', 'Email changed', {
        oldValue: 'a@example.com',
        newValue: 'b@example.com',
      }),
    );
    expect(result).toBe('Email changed from a@example.com to b@example.com');
  });

  it('lists comma-separated updated fields for profile_updated', () => {
    const result = formatEventDescription(
      activity('profile_updated', 'Profile updated', {
        updatedFields: ['username', 'avatar'],
      }),
    );
    expect(result).toBe('Profile updated: username, avatar');
  });

  it('coerces a non-array updatedFields value to string', () => {
    const result = formatEventDescription(
      activity('profile_updated', 'Profile updated', {
        updatedFields: 'bio',
      }),
    );
    expect(result).toBe('Profile updated: bio');
  });
});
