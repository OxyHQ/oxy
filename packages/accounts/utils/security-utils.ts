import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { SecurityEventType, SecurityEventSeverity, SecurityActivity } from '@oxyhq/core';

// Severity mapping (matches backend - single source of truth)
const SECURITY_EVENT_SEVERITY_MAP: Record<SecurityEventType, SecurityEventSeverity> = {
  'sign_in': 'low',
  'sign_out': 'low',
  'profile_updated': 'low',
  'email_changed': 'medium',
  'device_added': 'medium',
  'device_removed': 'medium',
  'security_settings_changed': 'medium',
  'account_recovery': 'high',
  'private_key_exported': 'high',
  'backup_created': 'high',
  'suspicious_activity': 'critical',
};

/**
 * Get icon name for security event type
 */
export function getEventIcon(eventType: SecurityEventType): keyof typeof MaterialCommunityIcons.glyphMap {
  switch (eventType) {
    case 'sign_in':
      return 'login';
    case 'sign_out':
      return 'logout';
    case 'email_changed':
      return 'email-edit';
    case 'profile_updated':
      return 'account-edit';
    case 'device_added':
      return 'devices';
    case 'device_removed':
      return 'monitor-off';
    case 'account_recovery':
      return 'key-variant';
    case 'security_settings_changed':
      return 'shield-edit';
    case 'private_key_exported':
      return 'printer';
    case 'backup_created':
      return 'file-export';
    case 'suspicious_activity':
      return 'alert-circle';
    default:
      return 'shield-check';
  }
}

/**
 * Get color for security event severity
 */
export function getSeverityColor(severity: SecurityEventSeverity, colorScheme: 'light' | 'dark'): string {
  const colors = {
    light: {
      low: '#34C759',        // Green - normal operations
      medium: '#FF9500',     // Orange - important changes
      high: '#AF52DE',       // Purple - critical actions
      critical: '#FF3B30',   // Red - security threats
    },
    dark: {
      low: '#30D158',        // Green - normal operations
      medium: '#FF9F0A',     // Orange - important changes
      high: '#BF5AF2',       // Purple - critical actions
      critical: '#FF453A',   // Red - security threats
    },
  };

  return colors[colorScheme][severity] || colors[colorScheme].low;
}

/**
 * Format event description with metadata
 */
export function formatEventDescription(activity: SecurityActivity): string {
  const { eventType, eventDescription, metadata } = activity;

  // For device-related events, include device name if available
  if ((eventType === 'device_added' || eventType === 'device_removed') && metadata?.deviceName) {
    return `${eventDescription} (${metadata.deviceName})`;
  }

  // For email changes, show the change
  if (eventType === 'email_changed' && metadata?.oldValue && metadata?.newValue) {
    return `Email changed from ${metadata.oldValue} to ${metadata.newValue}`;
  }

  // For profile updates, show which fields were updated
  if (eventType === 'profile_updated' && metadata?.updatedFields) {
    const fields = Array.isArray(metadata.updatedFields) 
      ? metadata.updatedFields.join(', ')
      : String(metadata.updatedFields);
    return `Profile updated: ${fields}`;
  }

  return eventDescription;
}

/**
 * Get severity level for event
 */
export function getEventSeverity(eventType: SecurityEventType): SecurityEventSeverity {
  return SECURITY_EVENT_SEVERITY_MAP[eventType] || 'low';
}

