import type { ComponentType } from 'react';
import type { BaseScreenProps } from '../types/navigation';

export type RouteName =
  | 'Supervision'
  | 'ManageAccount' // Unified "Manage your Oxy Account" surface
  | 'AccountVerification'
  | 'PaymentGateway'
  | 'Profile'
  | 'LanguageSelector'
  | 'PrivacySettings'
  | 'SearchSettings'
  | 'FileManagement'
  | 'FileTrash' // The person's trash: restore, or delete permanently (ADR 0043 D5)
  | 'HelpSupport'
  | 'ReportBug'
  | 'OxyOne'
  | 'LegalDocuments'
  | 'AppInfo'
  | 'WelcomeNewUser'
  | 'HistoryView'
  | 'EditProfile' // Profile-editing hub: one row per editable field
  | 'EditProfileField' // Dedicated screen for editing a single profile field
  | 'LearnMoreUsernames' // Informational screen about usernames
  | 'TrustCenter'
  | 'TrustLeaderboard'
  | 'TrustRewards'
  | 'TrustRules'
  | 'AboutTrust'
  | 'TrustFAQ'
  | 'FollowersList' // List of user's followers
  | 'FollowingList' // List of users being followed
  | 'CreateAccount' // Create a new account (organization / project / bot)
  | 'AccountMembers' // Manage an account's members (invite / roles / transfer)
  | 'AccountSettings' // Per-account profile edit + members + danger zone
  | 'ChangeAvatar' // Profile-picture source list — the ONE entry into changing an avatar
  | 'AvatarCrop' // Square-crop editor, reached by navigating within the ChangeAvatar surface
  | 'Notifications' // Per-channel notification preferences
  | 'ConnectedApps' // OAuth-authorized third-party apps the user can revoke
  | 'Domains' // Web domains the identity has proven it controls
  | 'Preferences' // General user preferences (theme, reduce-motion, etc.)
  | 'DeleteAccount' // Delete an account without a key, with a code by email
  | 'LinkCommons' // Link Commons: the account becomes self-custodied
  | 'SignInPassword' // Set or change the account's password
  | 'SignInAuthenticator' // The account's authenticator app and backup codes
  | 'AccountDialog'; // Unified account switcher + sign-in surface (OxyAccountDialogScreen body)

type ScreenComponents = Record<RouteName, ComponentType<never>>;
let components: ScreenComponents | undefined;
let loading: Promise<void> | undefined;

export function registerScreens(screens: ScreenComponents): void {
  components = screens;
}

export function screensReady(): boolean {
  return components !== undefined;
}

/** The lean client warms all screen code at provider startup, before navigation. */
export function loadScreens(): Promise<void> {
  if (components) return Promise.resolve();
  loading ??= import('./screenComponents')
    .then(({ screenComponents }) => {
      registerScreens(screenComponents);
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

export const getScreenComponent = (route: RouteName): ComponentType<BaseScreenProps> | undefined =>
  components?.[route] as ComponentType<BaseScreenProps> | undefined;

const ROUTES: ReadonlySet<string> = new Set([
  'Supervision',
  'FileTrash',
  'ManageAccount',
  'AccountVerification',
  'PaymentGateway',
  'Profile',
  'LanguageSelector',
  'PrivacySettings',
  'SearchSettings',
  'FileManagement',
  'HelpSupport',
  'ReportBug',
  'OxyOne',
  'LegalDocuments',
  'AppInfo',
  'WelcomeNewUser',
  'HistoryView',
  'EditProfile',
  'EditProfileField',
  'LearnMoreUsernames',
  'TrustCenter',
  'TrustLeaderboard',
  'TrustRewards',
  'TrustRules',
  'AboutTrust',
  'TrustFAQ',
  'FollowersList',
  'FollowingList',
  'CreateAccount',
  'AccountMembers',
  'AccountSettings',
  'ChangeAvatar',
  'AvatarCrop',
  'Notifications',
  'Domains',
  'ConnectedApps',
  'Preferences',
  'DeleteAccount',
  'LinkCommons',
  'SignInPassword',
  'SignInAuthenticator',
  'AccountDialog',
]);
export const isValidRoute = (name: string): name is RouteName => ROUTES.has(name);
