import type { ComponentType } from 'react';
import type { RouteName } from './routes';
import SupervisionScreenComponent from '../screens/SupervisionScreen';
import FileTrashScreenComponent from '../screens/FileTrashScreen';
import ManageAccountScreenComponent from '../screens/ManageAccountScreen';
import AccountVerificationScreenComponent from '../screens/AccountVerificationScreen';
import PaymentGatewayScreenComponent from '../screens/PaymentGatewayScreen';
import ProfileScreenComponent from '../screens/ProfileScreen';
import LanguageSelectorScreenComponent from '../screens/LanguageSelectorScreen';
import PrivacySettingsScreenComponent from '../screens/PrivacySettingsScreen';
import SearchSettingsScreenComponent from '../screens/SearchSettingsScreen';
import FileManagementScreenComponent from '../screens/FileManagementScreen';
import OxyOneScreenComponent from '../screens/OxyOneScreen';
import ReportBugScreenComponent from '../screens/ReportBugScreen';
import HelpSupportScreenComponent from '../screens/HelpSupportScreen';
import LegalDocumentsScreenComponent from '../screens/LegalDocumentsScreen';
import AppInfoScreenComponent from '../screens/AppInfoScreen';
import WelcomeNewUserScreenComponent from '../screens/WelcomeNewUserScreen';
import HistoryViewScreenComponent from '../screens/HistoryViewScreen';
import EditProfileScreenComponent from '../screens/EditProfileScreen';
import EditProfileFieldScreenComponent from '../screens/EditProfileFieldScreen';
import LearnMoreUsernamesScreenComponent from '../screens/LearnMoreUsernamesScreen';
import TrustCenterScreenComponent from '../screens/trust/TrustCenterScreen';
import TrustLeaderboardScreenComponent from '../screens/trust/TrustLeaderboardScreen';
import TrustRewardsScreenComponent from '../screens/trust/TrustRewardsScreen';
import TrustRulesScreenComponent from '../screens/trust/TrustRulesScreen';
import AboutTrustScreenComponent from '../screens/trust/TrustAboutScreen';
import TrustFAQScreenComponent from '../screens/trust/TrustFAQScreen';
import FollowersListScreenComponent from '../screens/FollowersListScreen';
import FollowingListScreenComponent from '../screens/FollowingListScreen';
import CreateAccountScreenComponent from '../screens/CreateAccountScreen';
import AccountMembersScreenComponent from '../screens/AccountMembersScreen';
import AccountSettingsScreenComponent from '../screens/AccountSettingsScreen';
import ChangeAvatarScreenComponent from '../screens/ChangeAvatarScreen';
import AvatarCropScreenComponent from '../screens/AvatarCropScreen';
import NotificationsScreenComponent from '../screens/NotificationsScreen';
import DomainsScreenComponent from '../screens/DomainsScreen';
import ConnectedAppsScreenComponent from '../screens/ConnectedAppsScreen';
import PreferencesScreenComponent from '../screens/PreferencesScreen';
import DeleteAccountScreenComponent from '../screens/DeleteAccountScreen';
import LinkCommonsScreenComponent from '../screens/LinkCommonsScreen';
import SignInPasswordScreenComponent from '../screens/SignInPasswordScreen';
import SignInAuthenticatorScreenComponent from '../screens/SignInAuthenticatorScreen';
import AccountDialogScreenComponent from '../components/OxyAccountDialogScreen';

export const screenComponents: Record<RouteName, ComponentType<never>> = {
  Supervision: SupervisionScreenComponent,
  FileTrash: FileTrashScreenComponent,
  ManageAccount: ManageAccountScreenComponent,
  AccountVerification: AccountVerificationScreenComponent,
  PaymentGateway: PaymentGatewayScreenComponent,
  Profile: ProfileScreenComponent,
  LanguageSelector: LanguageSelectorScreenComponent,
  PrivacySettings: PrivacySettingsScreenComponent,
  SearchSettings: SearchSettingsScreenComponent,
  FileManagement: FileManagementScreenComponent,
  HelpSupport: HelpSupportScreenComponent,
  ReportBug: ReportBugScreenComponent,
  OxyOne: OxyOneScreenComponent,
  LegalDocuments: LegalDocumentsScreenComponent,
  AppInfo: AppInfoScreenComponent,
  WelcomeNewUser: WelcomeNewUserScreenComponent,
  HistoryView: HistoryViewScreenComponent,
  EditProfile: EditProfileScreenComponent,
  EditProfileField: EditProfileFieldScreenComponent,
  // Informational screens
  LearnMoreUsernames: LearnMoreUsernamesScreenComponent,
  // Oxy Trust screens
  TrustCenter: TrustCenterScreenComponent,
  TrustLeaderboard: TrustLeaderboardScreenComponent,
  TrustRewards: TrustRewardsScreenComponent,
  TrustRules: TrustRulesScreenComponent,
  AboutTrust: AboutTrustScreenComponent,
  TrustFAQ: TrustFAQScreenComponent,
  // User list screens (followers/following)
  FollowersList: FollowersListScreenComponent,
  FollowingList: FollowingListScreenComponent,
  CreateAccount: CreateAccountScreenComponent,
  AccountMembers: AccountMembersScreenComponent,
  AccountSettings: AccountSettingsScreenComponent,
  ChangeAvatar: ChangeAvatarScreenComponent,
  AvatarCrop: AvatarCropScreenComponent,
  Notifications: NotificationsScreenComponent,
  Domains: DomainsScreenComponent,
  ConnectedApps: ConnectedAppsScreenComponent,
  Preferences: PreferencesScreenComponent,
  // The account's own sign-in security, in its settings.
  DeleteAccount: DeleteAccountScreenComponent,
  LinkCommons: LinkCommonsScreenComponent,
  SignInPassword: SignInPasswordScreenComponent,
  SignInAuthenticator: SignInAuthenticatorScreenComponent,
  // Unified account switcher + sign-in surface. Its body lives in the
  // `OxyAccountDialogScreen` component (folded from the standalone dialog); the
  // surface stack provides the Dialog chrome around it.
  AccountDialog: AccountDialogScreenComponent,
};
