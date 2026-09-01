import { lazy, type ComponentType } from 'react';
import type { BaseScreenProps } from '../types/navigation';

// Define all available route names
export type RouteName =
    | 'ManageAccount'    // Unified "Manage your Oxy Account" surface
    | 'AccountVerification'
    | 'PaymentGateway'
    | 'Profile'
    | 'LanguageSelector'
    | 'PrivacySettings'
    | 'SearchSettings'
    | 'FileManagement'
    | 'HelpSupport'
    | 'FAQ'
    | 'Feedback'
    | 'LegalDocuments'
    | 'AppInfo'
    | 'PremiumSubscription'
    | 'WelcomeNewUser'
    | 'UserLinks'
    | 'HistoryView'
    | 'SavesCollections'
    | 'EditProfile'      // Profile-editing hub: one row per editable field
    | 'EditProfileField' // Dedicated screen for editing a single profile field
    | 'LearnMoreUsernames' // Informational screen about usernames
    | 'TrustCenter'
    | 'TrustLeaderboard'
    | 'TrustRewards'
    | 'TrustRules'
    | 'AboutTrust'
    | 'TrustFAQ'
    | 'FollowersList'  // List of user's followers
    | 'FollowingList' // List of users being followed
    | 'CreateAccount' // Create a new account (organization / project / bot)
    | 'AccountMembers' // Manage an account's members (invite / roles / transfer)
    | 'AccountSettings' // Per-account profile edit + members + danger zone
    | 'ChangeAvatar' // Profile-picture source list — the ONE entry into changing an avatar
    | 'AvatarCrop' // Square-crop editor, reached by navigating within the ChangeAvatar surface
    | 'Notifications' // Per-channel notification preferences
    | 'ConnectedApps' // OAuth-authorized third-party apps the user can revoke
    | 'Preferences' // General user preferences (theme, reduce-motion, etc.)
    | 'AccountDialog'; // Unified account switcher + sign-in surface (OxyAccountDialogScreen body)

/**
 * The component for each route, loaded on demand.
 *
 * Every entry is `lazy(() => import(...))`: the screen module is fetched and
 * evaluated the first time its surface is presented, never at import time. That
 * matters twice over — screens import `OxyContext`, which reaches back here, so
 * eager evaluation would run screens mid-cycle; and it keeps native-only screen
 * dependencies out of the evaluation path of every consumer that merely touches
 * the SDK.
 *
 * What defers the load must NOT be `require()`. `@oxyhq/services` ships an ESM
 * build, and a `require()` in ESM output forces web bundlers into CommonJS
 * interop: rolldown-vite defers every module in the required subgraph behind a
 * lazy initializer and then hands a consumer that statically imported one of
 * them the still-`undefined` binding. That is how `OxySignInRequestSurface`
 * reached auth.oxy.so/authorize as `undefined` and blanked the page with React
 * error #130 — this registry pulled `OxyAccountDialogScreen`, and the whole
 * sign-in surface subgraph with it, through `require()`.
 *
 * The value type is `ComponentType<never>`, which every screen satisfies. A few
 * screens (`Profile`, `PaymentGateway`, `UserLinks`, `FollowersList`,
 * `FollowingList`) declare props BEYOND {@link BaseScreenProps} — `userId`,
 * `amount` — that only reach them through the route's untyped props bag
 * (`present(route, props)`), so this map cannot prove they are satisfied. The
 * previous `require()` returned `any` and hid that entirely; stating it here
 * confines the gap to one documented widening in {@link getScreenComponent}.
 */
const screenComponents: Record<RouteName, ComponentType<never>> = {
    ManageAccount: lazy(() => import('../screens/ManageAccountScreen')),
    AccountVerification: lazy(() => import('../screens/AccountVerificationScreen')),
    PaymentGateway: lazy(() => import('../screens/PaymentGatewayScreen')),
    Profile: lazy(() => import('../screens/ProfileScreen')),
    LanguageSelector: lazy(() => import('../screens/LanguageSelectorScreen')),
    PrivacySettings: lazy(() => import('../screens/PrivacySettingsScreen')),
    SearchSettings: lazy(() => import('../screens/SearchSettingsScreen')),
    FileManagement: lazy(() => import('../screens/FileManagementScreen')),
    HelpSupport: lazy(() => import('../screens/HelpSupportScreen')),
    FAQ: lazy(() => import('../screens/FAQScreen')),
    Feedback: lazy(() => import('../screens/FeedbackScreen')),
    LegalDocuments: lazy(() => import('../screens/LegalDocumentsScreen')),
    AppInfo: lazy(() => import('../screens/AppInfoScreen')),
    PremiumSubscription: lazy(() => import('../screens/PremiumSubscriptionScreen')),
    WelcomeNewUser: lazy(() => import('../screens/WelcomeNewUserScreen')),
    UserLinks: lazy(() => import('../screens/UserLinksScreen')),
    HistoryView: lazy(() => import('../screens/HistoryViewScreen')),
    SavesCollections: lazy(() => import('../screens/SavesCollectionsScreen')),
    EditProfile: lazy(() => import('../screens/EditProfileScreen')),
    EditProfileField: lazy(() => import('../screens/EditProfileFieldScreen')),
    // Informational screens
    LearnMoreUsernames: lazy(() => import('../screens/LearnMoreUsernamesScreen')),
    // Oxy Trust screens
    TrustCenter: lazy(() => import('../screens/trust/TrustCenterScreen')),
    TrustLeaderboard: lazy(() => import('../screens/trust/TrustLeaderboardScreen')),
    TrustRewards: lazy(() => import('../screens/trust/TrustRewardsScreen')),
    TrustRules: lazy(() => import('../screens/trust/TrustRulesScreen')),
    AboutTrust: lazy(() => import('../screens/trust/TrustAboutScreen')),
    TrustFAQ: lazy(() => import('../screens/trust/TrustFAQScreen')),
    // User list screens (followers/following)
    FollowersList: lazy(() => import('../screens/FollowersListScreen')),
    FollowingList: lazy(() => import('../screens/FollowingListScreen')),
    CreateAccount: lazy(() => import('../screens/CreateAccountScreen')),
    AccountMembers: lazy(() => import('../screens/AccountMembersScreen')),
    AccountSettings: lazy(() => import('../screens/AccountSettingsScreen')),
    ChangeAvatar: lazy(() => import('../screens/ChangeAvatarScreen')),
    AvatarCrop: lazy(() => import('../screens/AvatarCropScreen')),
    Notifications: lazy(() => import('../screens/NotificationsScreen')),
    ConnectedApps: lazy(() => import('../screens/ConnectedAppsScreen')),
    Preferences: lazy(() => import('../screens/PreferencesScreen')),
    // Unified account switcher + sign-in surface. Its body lives in the
    // `OxyAccountDialogScreen` component (folded from the standalone dialog); the
    // surface stack provides the Dialog chrome around it.
    AccountDialog: lazy(() => import('../components/OxyAccountDialogScreen')),
};

/**
 * Resolve the component for a route.
 *
 * The map is total over {@link RouteName} — the compiler enforces that at its
 * declaration — so this returns `undefined` only for a caller that reached here
 * with an unchecked string; {@link isValidRoute} is how such a caller narrows.
 *
 * The surface host renders the result with {@link BaseScreenProps} merged with
 * the route's own props bag, so that is the type it is handed back as. This one
 * widening is where the gap documented on {@link screenComponents} lives: the map
 * dispatches on a string key, so a screen's extra prop requirements are met at
 * `present(route, props)` call sites, not provable here. No caching is needed —
 * React memoizes each `lazy()` component's module after its first load.
 */
export const getScreenComponent = (routeName: RouteName): ComponentType<BaseScreenProps> | undefined =>
    screenComponents[routeName] as ComponentType<BaseScreenProps>;

// Helper function to check if a route exists
// Uses the screenComponents map to check existence without loading the screen
export const isValidRoute = (routeName: string): routeName is RouteName => {
    return routeName in screenComponents;
};
