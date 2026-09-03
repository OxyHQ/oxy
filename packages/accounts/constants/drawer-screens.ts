/**
 * Declarative configuration for the `(tabs)` drawer navigator.
 *
 * Replaces the eighteen hand-written `<Drawer.Screen>` blocks that previously
 * lived in `app/(tabs)/_layout.tsx`. Each entry maps a route file name to its
 * drawer label, header title, visibility and platform constraints; the layout
 * renders them in a single `.map()`.
 *
 * `labelKey` / `titleKey` are dot-paths into the i18n dictionary (resolved with
 * `t()` at render time). `hidden` entries are kept out of the drawer list but
 * still registered so deep links and programmatic navigation resolve.
 * `headerShown` defaults to the navigator-level value when omitted.
 *
 * Lives under `constants/` (not `app/`) so expo-router does not treat it as a
 * route module.
 */

/** A route name that maps to a file inside `app/(tabs)`. */
export type DrawerRouteName =
  | 'index'
  | 'personal-info'
  | 'security'
  | 'agency'
  | 'activity'
  | 'devices'
  | 'data'
  | 'sharing'
  | 'family'
  | 'payments'
  | 'storage'
  | 'managed-accounts'
  | 'sessions'
  | 'search'
  | 'authorize'
  | 'scan-qr';

export interface DrawerScreenConfig {
  /** Route file name under `app/(tabs)` — the `name` prop of `<Drawer.Screen>`. */
  name: DrawerRouteName;
  /** i18n key for the drawer item label. Omitted for hidden screens. */
  labelKey?: string;
  /** i18n key for the screen header title. */
  titleKey?: string;
  /** When true, the screen is registered but not listed in the drawer. */
  hidden?: boolean;
  /** When false, this screen renders without the shared header. */
  headerShown?: boolean;
  /** When 'native', the screen is only registered off the web platform. */
  platform?: 'native';
}

export const DRAWER_SCREENS: readonly DrawerScreenConfig[] = [
  { name: 'index', labelKey: 'drawer.home', titleKey: 'drawer.home' },
  { name: 'personal-info', labelKey: 'drawer.personalInfo', titleKey: 'drawer.personalInfo' },
  { name: 'security', labelKey: 'drawer.security', titleKey: 'drawer.security' },
  { name: 'agency', labelKey: 'drawer.agency', titleKey: 'drawer.agency' },
  { name: 'activity', labelKey: 'drawer.activity', titleKey: 'drawer.activity' },
  { name: 'devices', labelKey: 'drawer.devices', titleKey: 'drawer.devices' },
  { name: 'data', labelKey: 'drawer.data', titleKey: 'drawer.data' },
  { name: 'sharing', labelKey: 'drawer.sharing', titleKey: 'drawer.sharing' },
  { name: 'family', labelKey: 'drawer.thirdParty', titleKey: 'drawer.thirdParty' },
  { name: 'payments', labelKey: 'drawer.payments', titleKey: 'drawer.payments' },
  { name: 'storage', labelKey: 'drawer.storage', titleKey: 'drawer.storage' },
  { name: 'managed-accounts', labelKey: 'drawer.yourIdentities', titleKey: 'drawer.yourIdentities' },
  { name: 'sessions', hidden: true },
  { name: 'search', hidden: true },
  { name: 'authorize', hidden: true, titleKey: 'drawer.authorize' },
  { name: 'scan-qr', hidden: true, titleKey: 'drawer.scanQr', headerShown: false },
] as const;
