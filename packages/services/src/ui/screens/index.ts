/**
 * Explicit screen entry point.
 *
 * Most applications should open these through the surface API. Applications
 * that intentionally embed a screen import it from this subpath, accepting the
 * corresponding screen module in their own bundle. Screens must never be
 * re-exported by the package root or `./ui`: doing so defeats the lazy surface
 * registry for every consumer.
 */
export { default as ProfileScreen } from './ProfileScreen';
export { default as ManageAccountScreen } from './ManageAccountScreen';
export { default as NotificationsScreen } from './NotificationsScreen';
export { default as PreferencesScreen } from './PreferencesScreen';
export { default as ConnectedAppsScreen } from './ConnectedAppsScreen';
export { default as CreateAccountScreen } from './CreateAccountScreen';
export { default as AccountMembersScreen } from './AccountMembersScreen';
export { default as AccountSettingsScreen } from './AccountSettingsScreen';

export { default as SupervisionScreen } from './SupervisionScreen';
export { default as OxyOneScreen } from './OxyOneScreen';

// The body of the `AccountSettings` surface, for an app embedding a managed
// account's settings in its own page with its own sections around them.
export {
  AccountSettings,
  type AccountSettingsProps,
  type AccountSettingsArchiveOptions,
} from '../components/accountSettings/AccountSettings';
