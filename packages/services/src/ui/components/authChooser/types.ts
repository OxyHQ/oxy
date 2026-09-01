/**
 * Shared types + per-account color resolution for the auth chooser's views.
 *
 * One responsibility: the vocabulary every view module in this folder speaks
 * (theme/translate aliases, the container-supplied action bundles, and the
 * account accent). No JSX, no state, no I/O — so a view can import it without
 * dragging any other view in.
 */

import { APP_COLOR_NAMES, APP_COLOR_PRESETS, type AppColorName, type useTheme } from '@oxyhq/bloom/theme';
import type { useI18n } from '../../hooks/useI18n';

export type Theme = ReturnType<typeof useTheme>;
export type Translate = ReturnType<typeof useI18n>['t'];

/**
 * One SUBORDINATE action on a sign-in surface — an alternative revealed behind
 * "Having trouble?", or a non-competing link under the primary.
 *
 * Never a primary button: a sign-in surface presents exactly ONE of those (issue
 * #691), and keeping every other affordance on this single shape is what stops
 * one of them quietly growing into a co-equal button again.
 *
 * Part of the public SDK surface — `OxySignInRequestSurface` takes these.
 */
export interface OxySignInSurfaceAction {
  /** Stable identity for the list, and the action's `testID`. */
  key: string;
  /** Already-localized label. The host resolves its own copy. */
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** The account-row actions the container wires for the switcher + menu views. */
export interface OxyAuthChooserHandlers {
  /**
   * Become one `principal acting as account` pair.
   *
   * A `contextId`, never an `accountId`: on a device holding two people the
   * same organization is reachable through both, and an account id cannot name
   * which person's route to take.
   */
  onActivate: (contextId: string) => void;
  /**
   * Drop ONE pair. The same account reached through somebody else stays — that
   * is a different session with a different audit actor.
   */
  onRemoveContext: (contextId: string) => void;
  /** Drop ONE PERSON and every account they reach here, and nobody else's. */
  onRemovePrincipal: (principalId: string) => void;
  onAdd: () => void;
  onManage: () => void;
  /**
   * Change the current account's photo — opens the avatar-change flow. Because
   * the account menu lives in the AccountDialog surface, this MORPHS that surface
   * into `ChangeAvatar` (via `openAvatarPicker` → `openWithinOrPresent`), the same
   * flow ManageAccount's avatar uses; it never stacks a new dialog.
   */
  onEditAvatar: () => void;
}

/**
 * The account menu's HERO block — the current account, rendered large.
 *
 * Built by the container from `useOxy().user`, not from a directory row, and
 * that asymmetry is deliberate rather than an oversight: the directory carries
 * the minimum that renders a row (name, handle, avatar) for EVERY person on the
 * device, while the account this client is actually signed in as is the one it
 * legitimately holds a full profile for — so the hero keeps its real email and
 * its own accent colour, and the rows below it do not pretend to.
 */
export interface AccountHeroModel {
  displayName: string;
  /** The canonical `@oxy.so` email when there is one, else the `@handle`. */
  addressLine: string | null;
  avatarUrl: string | undefined;
  /** The account's own Bloom accent, resolved to a hex. */
  accentHex: string;
}

/** Used/total storage bytes for the "Oxy storage" block, or `null` when unknown. */
export interface AccountStorageModel {
  usedBytes: number;
  limitBytes: number;
}

/** The account-menu row actions the container wires (deep-links / sheets / sign-out). */
export interface AccountsMenuActions {
  onOpenSettings: () => void;
  onOpenData: () => void;
  onManageStorage: () => void;
  onUpgradeStorage: () => void;
  onHelp: () => void;
  onPrivacy: () => void;
  onTerms: () => void;
  onSignOut: () => void;
  customItems: readonly {
    key: string;
    label: string;
    icon?: string;
    onPress: () => void;
  }[];
}

/**
 * Where a WebAuthn ceremony can run from the current origin.
 *
 * A credential minted for `oxy.so` can only be ASSERTED there (or a loopback
 * dev host) — a hard, browser-enforced RP-ID boundary, not feature detection.
 * `'direct'` = a first-party Oxy web origin, the ceremony runs here.
 * `'hub'`    = any other web origin; it runs in the auth.oxy.so popup instead.
 * `'none'`   = native, where Commons owns identity.
 */
export type PasskeyMode = 'direct' | 'hub' | 'none';

/**
 * Everything that is NOT the sign-in surface's one primary action.
 *
 * The container wires these once; each view decides which of them are genuine
 * alternatives to ITS primary surface and hands those to `TroubleDisclosure`
 * (issue #691: fallbacks stay hidden until the user asks or the primary route
 * fails). A view never renders one of these as a button.
 */
export interface SignInAlternatives {
  /** Whether a WebAuthn ceremony is reachable from this origin at all. */
  passkeyAvailable: boolean;
  /**
   * `true` while a DIRECT ceremony is in flight. The hub-popup variant reports
   * its progress through `snapshot.signIn` instead, so it never sets this.
   */
  passkeyPending: boolean;
  onSignInWithPasskey: () => void;
  /** Fall back to the cross-device QR handoff (restarts the request). */
  onShowQr: () => void;
  /** Open the Commons store listing / landing page for this platform. */
  onGetCommons: () => void;
  /** Enter the account-creation view. */
  onCreateAccount: () => void;
}

/**
 * Resolve an account's stored color (a named Bloom preset, e.g. `'purple'`) to
 * a concrete brand hex for the row accent. Falls back to the theme primary when
 * the account has no color or the value is not a recognized preset, so the accent
 * renders in EVERY consumer regardless of NativeWind availability.
 */
export function resolveAccentHex(color: string | null, fallback: string): string {
  const preset = toPreset(color);
  return preset ? APP_COLOR_PRESETS[preset].hex : fallback;
}

/** Narrow a stored color string to a known `AppColorName`, or `undefined`. */
export function toPreset(color: string | null): AppColorName | undefined {
  if (!color) return undefined;
  return (APP_COLOR_NAMES as readonly string[]).includes(color)
    ? (color as AppColorName)
    : undefined;
}
