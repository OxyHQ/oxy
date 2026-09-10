import type { ReactNode } from 'react';
import type { AccountDialogView, FileMetadata } from '@oxy.so/core';
import type { RouteName } from './routes';
import type { AvatarCropResult } from '../screens/AvatarCropScreen';
import type { AvatarRemovalResult } from '../screens/ChangeAvatarScreen';

/**
 * The SDK's typed surface registry — the contract layer the SDK stacks on top of
 * Bloom's content-agnostic surface stack (`@oxy.so/bloom/surfaces`). One entry per
 * route describing its `props` (what the presenter must pass) and its `result`
 * (what awaiting `present()` resolves with). Hand-maintained, contract-first:
 * adding a route here is the single edit that types it end to end.
 *
 * For P1 most routes keep permissive `Record<string, unknown>` props + a `void`
 * result — the historical grab-bag `showBottomSheet`/`navigate` props are
 * unchanged. Later phases tighten individual routes without changing this shape.
 */

/** One registry entry: the props a route is presented with + its dismissal result. */
type SurfaceRoute<Props = Record<string, unknown>, Result = void> = {
  props: Props;
  result: Result;
};

export interface SurfaceRegistry {
  ManageAccount: SurfaceRoute;
  AccountVerification: SurfaceRoute;
  PaymentGateway: SurfaceRoute;
  Profile: SurfaceRoute;
  LanguageSelector: SurfaceRoute;
  PrivacySettings: SurfaceRoute;
  SearchSettings: SurfaceRoute;
  /**
   * File picker / manager. In single-select picker mode the surface is
   * dismissed with the picked {@link FileMetadata} (the avatar-picker promise
   * flow); legacy callers that pass an `onSelect`/`onConfirmSelection` callback
   * keep their callback behaviour and this result goes unread.
   */
  FileManagement: SurfaceRoute<Record<string, unknown>, FileMetadata>;
  HelpSupport: SurfaceRoute;
  FAQ: SurfaceRoute;
  Feedback: SurfaceRoute;
  LegalDocuments: SurfaceRoute;
  AppInfo: SurfaceRoute;
  PremiumSubscription: SurfaceRoute;
  WelcomeNewUser: SurfaceRoute;
  UserLinks: SurfaceRoute;
  HistoryView: SurfaceRoute;
  SavesCollections: SurfaceRoute;
  EditProfile: SurfaceRoute;
  EditProfileField: SurfaceRoute;
  LearnMoreUsernames: SurfaceRoute;
  TrustCenter: SurfaceRoute;
  TrustLeaderboard: SurfaceRoute;
  TrustRewards: SurfaceRoute;
  TrustRules: SurfaceRoute;
  AboutTrust: SurfaceRoute;
  TrustFAQ: SurfaceRoute;
  FollowersList: SurfaceRoute;
  FollowingList: SurfaceRoute;
  CreateAccount: SurfaceRoute;
  AccountMembers: SurfaceRoute;
  AccountSettings: SurfaceRoute;
  /**
   * Profile-picture source list — the ONE entry into changing an avatar. Every
   * source that yields an image navigates WITHIN this surface to `AvatarCrop`
   * (so the panel morphs), and the crop's own dismissal resolves this surface.
   * Hence the union: a confirmed crop, or the user removing their photo.
   */
  ChangeAvatar: SurfaceRoute<Record<string, unknown>, AvatarCropResult | AvatarRemovalResult>;
  /**
   * Square-crop editor. Dismissed with the cropped {@link AvatarCropResult}.
   * Reached only by navigating within a `ChangeAvatar` surface.
   */
  AvatarCrop: SurfaceRoute<Record<string, unknown>, AvatarCropResult>;
  Notifications: SurfaceRoute;
  ConnectedApps: SurfaceRoute;
  Preferences: SurfaceRoute;
  /** Unified account switcher + sign-in surface (folded `OxyAccountDialogScreen` body). */
  AccountDialog: SurfaceRoute<{ initialView?: AccountDialogView }>;
}

/**
 * Compile-time guard: the registry keys must be EXACTLY the route names. If a new
 * `RouteName` is added without a registry entry (or vice-versa) this alias
 * resolves to `never` and the `satisfies` assertion below fails to type-check.
 */
type RegistryCoversRoutes = [RouteName] extends [keyof SurfaceRegistry]
  ? [keyof SurfaceRegistry] extends [RouteName]
    ? true
    : never
  : never;
const _registryCoversRoutes: RegistryCoversRoutes = true;
void _registryCoversRoutes;

/** Typed props a route is presented with. */
export type SurfaceProps<K extends RouteName> = SurfaceRegistry[K]['props'];
/** What awaiting a route's `present()` resolves with when it is dismissed. */
export type SurfaceResult<K extends RouteName> = SurfaceRegistry[K]['result'];

/**
 * How a surface renders — the SDK's presentation taxonomy. Each value maps to a
 * concrete Bloom `Dialog` placement/chrome in `surfaces.ts`:
 *
 *   - `'sheet'`      → responsive `{ base: 'bottom', md: 'center' }` (the default,
 *                      and — since every screen morphs — the presentation of EVERY
 *                      route today: a bottom sheet on narrow, a centered card wide).
 *   - `'center'`     → a plain centered modal at every width. Currently unused.
 *   - `'drawer'`     → responsive `{ base: 'bottom', md: 'left' }` side drawer.
 *                      Currently unused.
 *   - `'fullScreen'` → a flush black-canvas surface (`contentPadding: 0`,
 *                      programmatic-only dismiss). Currently unused: the flagship
 *                      photo picker now MORPHS in place as a `sheet` (it paints its
 *                      own black canvas + bar inside the themed panel), so nothing
 *                      needs a stacked full-bleed surface. Retained for a future
 *                      route that genuinely must be full-bleed.
 */
export type SurfacePresentation = 'sheet' | 'center' | 'drawer' | 'fullScreen';

/**
 * Per-route surface configuration. Merges the historical `SheetRouteConfig`
 * knobs with the new {@link SurfacePresentation}.
 *
 * NOTE: `scrollable` is LIVE — it is threaded through `bloomOptionsFor` onto the
 * Bloom `Dialog` surface (`scrollable` prop), so a route that owns its own scroll
 * container opts OUT of the Dialog's internal ScrollView. `manualActivation` /
 * `dynamicBackdrop` / `handleComponent` remain informational — reserved for a
 * future Bloom bottom-placement passthrough; the shared `DialogBottomSheet`
 * currently owns pan coordination itself.
 */
export interface SurfaceRouteConfig {
  /** Which surface hosts the route. */
  presentation: SurfacePresentation;
  /**
   * When `false`, the route owns its own scroll container (a FlatList /
   * SectionList / VirtualizedList, or its own ScrollView) and the host must not
   * wrap it in a ScrollView. Threaded onto Bloom's `Dialog` via `bloomOptionsFor`.
   */
  scrollable: boolean;
  /**
   * Whether the surface MORPHS when this route is navigated to WITHIN it — the
   * panel animates from the outgoing frame's size to this one's instead of
   * hard-cutting (the in-place NAV-WITHIN size animation). `true` for every
   * ordinary route screen; a wizard step swap counts as a frame here too.
   *
   * Distinct from {@link stacks}: `morph` tunes the size animation of an IN-PLACE
   * frame swap; `stacks` decides whether the frame lands in place at all or opens
   * a new surface. A stacked surface can still morph between ITS OWN frames.
   */
  morph: boolean;
  /**
   * An EXPLICIT target size the panel MORPHS to for this route, instead of the
   * measured natural height / the surface width. This is how an own-scroller frame
   * (its content owns its own scroll, so the panel can't measure it) still GROWS
   * its container to a large declared size — the panel animates UP to it on entry
   * and back DOWN on exit while the frame's inner list scrolls within. `heightRatio`
   * is a fraction of the viewport height (clamped there); `maxWidth` (px) widens the
   * centered card beyond the ordinary sheet. Omit for the normal measured behaviour.
   */
  frameSize?: { heightRatio?: number; maxWidth?: number };
  /**
   * Whether navigating TO this route from INSIDE an existing surface opens a NEW
   * stacked surface (its own backdrop + entry animation — the DEPTH axis) instead
   * of morphing in place within the current one (the NAV-WITHIN axis).
   *
   * `false` (the DEFAULT) — morph in place: the route is pushed as a frame in the
   * host surface's nav stack and the panel reshapes from the previous frame to it
   * (size-animated per {@link morph}). Every ordinary screen. This is what makes
   * morph the default: a drill-in navigates WITHIN unless the target opts out.
   *
   * `true` — the route's chrome is fundamentally incompatible with morphing into
   * a host, so it must own its own surface: the full-bleed `fullScreen` image
   * picker (black canvas, flush content, programmatic-only dismiss). Presented on
   * top; dismissing it unwinds back to the surface that opened it.
   *
   * NOTE: the DEPTH `present` / `presentDetached` APIs ALWAYS open a new surface
   * regardless of this flag — `stacks` only governs the in-surface drill-in
   * (`navigate` / `showBottomSheet`) decision in `navigateWithinOrPresent`.
   */
  stacks: boolean;
  /**
   * Whether the surface renders the Dialog's OWN navigation header (sticky
   * gradient nav bar + large collapsing title over the surface's scroll content).
   * `true` for EVERY route — the whole SDK UI is unified on the shared header:
   * screens render NO header of their own and declare their title/subtitle (+ any
   * action slot / `onBack`) via `useSurfaceHeader`. No route opts out anymore.
   */
  header: boolean;
  /** Body-pan activation strategy — reserved (owned by Bloom's Dialog surface). */
  manualActivation: boolean;
  /** Drag-proportional backdrop dim — reserved (owned by Bloom's Dialog surface). */
  dynamicBackdrop: boolean;
  /** Optional custom drag-handle slot — reserved (owned by Bloom's Dialog surface). */
  handleComponent?: () => ReactNode;
}

/** Defaults shared across all routes — the canonical responsive "sheet". */
const DEFAULT_SURFACE_CONFIG: SurfaceRouteConfig = {
  presentation: 'sheet',
  scrollable: true,
  header: true,
  morph: true,
  stacks: false,
  manualActivation: true,
  dynamicBackdrop: true,
};

/**
 * Predicate matching `FileManagementScreen`'s internal `isImageOnlyPicker`
 * derivation. When the consumer restricts to image MIME types (no videos, no
 * audio, no documents), FileManagement renders the flagship `PhotoPickerView`,
 * which owns its own FlatList and reads best as a full-bleed picker. Kept in sync
 * with `FileManagementScreen` — both check the same disabled MIME type families.
 */
const isFileManagementImageOnlyPicker = (props: Record<string, unknown>): boolean => {
  if (!props.selectMode) return false;
  const disabled = props.disabledMimeTypes;
  if (!Array.isArray(disabled) || disabled.length === 0) return false;
  const has = (predicate: (mt: string) => boolean): boolean =>
    disabled.some((mt) => typeof mt === 'string' && predicate(mt));
  const blocksVideos = has((mt) => mt === 'video/' || mt.startsWith('video/'));
  const blocksAudio = has((mt) => mt === 'audio/' || mt.startsWith('audio/'));
  const blocksDocs = has(
    (mt) => mt === 'application/pdf' || mt === 'application/' || mt.startsWith('application/'),
  );
  return blocksVideos && blocksAudio && blocksDocs;
};

/**
 * Routes whose screen owns its OWN scroll container — a FlatList /
 * VirtualizedList (`ConnectedApps`, `TrustLeaderboard`, `FollowersList` /
 * `FollowingList` via `UserListScreen`) or its own vertical `ScrollView`
 * (`FileManagement`). These MUST opt out of the Dialog's internal ScrollView
 * (`scrollable: false`) so there is exactly ONE scroll container — otherwise a
 * VirtualizedList nests inside a plain ScrollView (RN warning) or a nested
 * vertical scroll-in-scroll breaks windowing. Screens with only a HORIZONTAL
 * ScrollView (FAQ's category row, Premium's plan carousel) are NOT listed — a
 * horizontal scroller does not conflict with the Dialog's vertical scroll.
 */
const OWN_SCROLL_CONTAINER_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'FileManagement',
  'ConnectedApps',
  'TrustLeaderboard',
  'FollowersList',
  'FollowingList',
]);

/**
 * Resolve the surface configuration for a route + props. Every route defaults to
 * the responsive sheet, renders the SHARED Dialog nav header, and MORPHS in place
 * when navigated to from within a surface (no route stacks — genuine overlays are
 * Bloom-raw `surfaces.present`/`confirm` calls, outside this registry). The
 * image-only FileManagement picker is a normal sheet that owns its own scroll and
 * grows to a large morph target; every other own-scroller is `scrollable: false`.
 */
export const getSurfaceConfig = (
  route: RouteName,
  props: Record<string, unknown>,
): SurfaceRouteConfig => {
  if (route === 'FileManagement' && isFileManagementImageOnlyPicker(props)) {
    // The flagship photo picker MORPHS in place like every other screen. It is an
    // own-scroller (`PhotoPickerView`'s FlatList) that paints its full-bleed black
    // photo canvas as CONTENT under the SHARED Dialog nav header (Cancel / title /
    // Upload), exactly like the crop stage under the same bar. It needs ROOM for
    // the photo grid, so it declares an explicit LARGE morph target — the panel
    // grows UP to a near-full-height, wider card on entry (and back down on
    // pick→crop), the grid scrolling within.
    return {
      ...DEFAULT_SURFACE_CONFIG,
      scrollable: false,
      frameSize: { heightRatio: 0.9, maxWidth: 640 },
    };
  }
  if (OWN_SCROLL_CONTAINER_ROUTES.has(route)) {
    // Own-scroller list screens keep the nav header (static, non-collapsing —
    // there is no Dialog scroll offset to drive the large-title collapse).
    return { ...DEFAULT_SURFACE_CONFIG, scrollable: false };
  }
  return DEFAULT_SURFACE_CONFIG;
};

/** Convenience: just the presentation taxonomy for a route + props. */
export const getSurfacePresentation = (
  route: RouteName,
  props: Record<string, unknown>,
): SurfacePresentation => getSurfaceConfig(route, props).presentation;
