/**
 * Type-safe icon name utilities
 *
 * Provides centralized, typed icon name mappings to eliminate `as any` casts
 * when using dynamic icon names with @expo/vector-icons.
 */

/**
 * Profile field icons (MaterialCommunityIcons)
 */
export const PROFILE_FIELD_ICONS = {
  displayName: 'account-outline',
  username: 'at',
  email: 'email-outline',
  bio: 'text-box-outline',
  location: 'map-marker-outline',
  links: 'link-variant',
  website: 'web',
  phone: 'phone-outline',
  birthday: 'cake-variant-outline',
} as const;

export type ProfileFieldIconKey = keyof typeof PROFILE_FIELD_ICONS;

/**
 * Get icon name for a profile field
 */
export function getProfileFieldIcon(field: string): string {
  return PROFILE_FIELD_ICONS[field as ProfileFieldIconKey] ?? 'account-outline';
}

/**
 * Settings section icons (MaterialCommunityIcons)
 */
export const SETTINGS_ICONS = {
  account: 'account-cog-outline',
  privacy: 'shield-account-outline',
  security: 'lock-outline',
  notifications: 'bell-outline',
  language: 'translate',
  appearance: 'palette-outline',
  storage: 'folder-outline',
  help: 'help-circle-outline',
  about: 'information-outline',
  logout: 'logout',
} as const;

export type SettingsIconKey = keyof typeof SETTINGS_ICONS;

/**
 * Get icon name for a settings section
 */
export function getSettingsIcon(section: string): string {
  return SETTINGS_ICONS[section as SettingsIconKey] ?? 'cog-outline';
}

/**
 * File type icons (MaterialCommunityIcons)
 */
export const FILE_TYPE_ICONS = {
  image: 'image-outline',
  video: 'video-outline',
  audio: 'music-note-outline',
  document: 'file-document-outline',
  pdf: 'file-pdf-box',
  archive: 'folder-zip-outline',
  code: 'code-tags',
  spreadsheet: 'file-excel-outline',
  presentation: 'file-presentation-outline',
  text: 'file-document-edit-outline',
  unknown: 'file-outline',
} as const;

export type FileTypeIconKey = keyof typeof FILE_TYPE_ICONS;

/**
 * Get icon name for a file type
 */
export function getFileTypeIcon(type: string): string {
  return FILE_TYPE_ICONS[type as FileTypeIconKey] ?? FILE_TYPE_ICONS.unknown;
}

/**
 * Action icons (Ionicons)
 */
export const ACTION_ICONS = {
  close: 'close',
  back: 'chevron-back',
  forward: 'chevron-forward',
  add: 'add',
  remove: 'remove',
  delete: 'trash-outline',
  edit: 'pencil-outline',
  save: 'checkmark',
  cancel: 'close',
  search: 'search-outline',
  filter: 'filter-outline',
  sort: 'swap-vertical-outline',
  refresh: 'refresh-outline',
  share: 'share-outline',
  copy: 'copy-outline',
  download: 'download-outline',
  upload: 'cloud-upload-outline',
} as const;

export type ActionIconKey = keyof typeof ACTION_ICONS;

/**
 * Get icon name for an action
 */
export function getActionIcon(action: string): string {
  return ACTION_ICONS[action as ActionIconKey] ?? 'ellipsis-horizontal';
}

/**
 * Status icons (Ionicons)
 */
export const STATUS_ICONS = {
  success: 'checkmark-circle',
  error: 'alert-circle',
  warning: 'warning',
  info: 'information-circle',
  loading: 'hourglass-outline',
  pending: 'time-outline',
  online: 'ellipse',
  offline: 'ellipse-outline',
} as const;

export type StatusIconKey = keyof typeof STATUS_ICONS;

/**
 * Get icon name for a status
 */
export function getStatusIcon(status: string): string {
  return STATUS_ICONS[status as StatusIconKey] ?? 'help-circle-outline';
}
