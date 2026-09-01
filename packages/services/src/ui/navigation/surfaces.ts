import { createElement } from 'react';
import type { ViewStyle } from 'react-native';
import {
  surfaces as bloomSurfaces,
  type PresentOptions,
  type SurfaceControls,
} from '@oxyhq/bloom/surfaces';
import type { RouteName } from './routes';
import {
  getSurfaceConfig,
  type SurfaceProps,
  type SurfaceResult,
  type SurfaceRouteConfig,
} from './surfaceRegistry';
import { createSurfaceNavStack, type SurfaceNavStack } from './surfaceNavStack';
import SurfaceScreen from '../components/SurfaceScreen';

/**
 * The SDK's typed surface API — a route registry layered on top of Bloom's
 * content-agnostic surface stack (`@oxyhq/bloom/surfaces`).
 *
 * `present(route)` opens a NEW Bloom surface (the DEPTH axis) whose content is a
 * {@link SurfaceScreen} driven by the route's own {@link SurfaceNavStack} (the
 * NAV-WITHIN axis). Navigating within that surface mutates its nav stack and
 * re-renders the SAME Bloom surface; presenting stacks another surface on top.
 *
 * Bloom coordinates z-order / backdrop / dismiss across every surface (SDK's and
 * apps'), so nothing clashes.
 */

/** Responsive "sheet": bottom sheet on narrow, centered card on wide. */
const SHEET_PLACEMENT = { base: 'bottom', md: 'center' } as const;

/** Full-bleed black canvas for the `'fullScreen'` approximation (image picker). */
const FULLSCREEN_SURFACE_STYLE: ViewStyle = { backgroundColor: '#000000', overflow: 'hidden' };

/**
 * Every SDK screen owns its own background + content padding + scroll region
 * (they were authored for the bare `BottomSheet`). So the shared `Dialog` must
 * NOT add its own `contentPadding` on top (that double-pads) — it owns only the
 * structural chrome: the surface card, the size cap (`maxHeightRatio`) and the
 * scroll boundary. `contentPadding: 0` makes the screen's own padding the single
 * source, matching the image-picker (`fullScreen`) surface.
 */
const SDK_SURFACE_CHROME = { contentPadding: 0, maxHeightRatio: 0.9 } as const;

/** Map a route's presentation taxonomy onto concrete Bloom `Dialog` options. */
function bloomOptionsFor(config: SurfaceRouteConfig): PresentOptions {
  // Threaded onto every placement so a route that owns its own scroll container
  // (`scrollable: false`) opts out of the Dialog's internal ScrollView.
  const scrollable = config.scrollable;
  // Surface-level morph opt-out (the DEPTH axis is untouched — this only governs
  // whether the panel reshapes when the content is swapped in place). Each frame
  // additionally declares its own opt-out through `useDialogFrame` in
  // `SurfaceScreen`, so a surface can morph for most routes and not for one.
  const morph = config.morph;
  // Nav-header mode marker: turns on the Dialog's OWN sticky gradient nav bar +
  // large collapsing title over its scroll content. The title/subtitle/action
  // slots are contributed at runtime by the mounted screen via `useSurfaceHeader`
  // (resolved in `SurfaceScreen`), so the seed here just enables the scaffold.
  const header = config.header ? { largeTitle: true } : undefined;
  switch (config.presentation) {
    case 'center':
      return { placement: 'center', scrollable, header, morph, ...SDK_SURFACE_CHROME };
    case 'drawer':
      return {
        placement: { base: 'bottom', md: 'left' },
        scrollable,
        header,
        morph,
        ...SDK_SURFACE_CHROME,
      };
    case 'fullScreen':
      // Approximate a full-screen surface with the shared `Dialog`: a tall
      // sheet / large centered card, flush content, a black canvas and
      // programmatic-only dismiss — matching the shipped image-picker Dialog.
      return {
        placement: SHEET_PLACEMENT,
        contentPadding: 0,
        maxWidth: 640,
        maxHeightRatio: 0.9,
        dismissOnBackdrop: false,
        scrollable,
        morph,
        style: FULLSCREEN_SURFACE_STYLE,
        panelStyle: FULLSCREEN_SURFACE_STYLE,
      };
    default:
      return { placement: SHEET_PLACEMENT, scrollable, header, morph, ...SDK_SURFACE_CHROME };
  }
}

/**
 * A live handle to a presented SDK surface. Exposes DEPTH controls (`dismiss`,
 * `result`) and NAV-WITHIN controls (`navigate`/`replace`/`goBack`/`setStep`) that
 * drive this surface's own nav stack. Held by the `showBottomSheet` adapter (base
 * surface) and by `OxyContext` (the AccountDialog surface).
 */
export interface SurfaceInstance<K extends RouteName = RouteName> {
  readonly route: RouteName;
  navigate: (route: RouteName, props?: Record<string, unknown>) => void;
  replace: (route: RouteName, props?: Record<string, unknown>) => void;
  goBack: () => boolean;
  canGoBack: () => boolean;
  setStep: (step: number) => void;
  /** Open a result-bearing sub-flow WITHIN this surface (morph). See {@link openWithinOrPresent}. */
  beginFlow: (route: RouteName, props?: Record<string, unknown>) => Promise<unknown>;
  dismiss: (result?: SurfaceResult<K>) => void;
  readonly result: Promise<SurfaceResult<K> | undefined>;
}

/**
 * The type-erased handle the `showBottomSheet` adapter needs from a tracked
 * surface: what it hosts, and how to drive/dismiss it. Kept result-type-free so
 * the (generic) `SurfaceInstance<K>` never has to be widened into a shared array.
 * Exported so `OxyContext` can hold the surface it MORPHS the account dialog into
 * (see {@link topRouteSurface}).
 */
export interface TrackedSurface {
  readonly route: RouteName;
  navigate: (route: RouteName, props?: Record<string, unknown>) => void;
  goBack: () => boolean;
  /** Open a result-bearing sub-flow WITHIN this surface (morph). See {@link openWithinOrPresent}. */
  beginFlow: (route: RouteName, props?: Record<string, unknown>) => Promise<unknown>;
  dismiss: () => void;
}

/**
 * Active SDK "route" surfaces (the `showBottomSheet` lineage), bottom → top.
 * `present`/`presentRoute` register here; `presentDetached` (AccountDialog) does
 * NOT, so the base-sheet navigation logic never treats the account modal as a
 * navigable base. Entries self-remove when their surface is dismissed.
 */
const activeRouteSurfaces: TrackedSurface[] = [];

/**
 * The frontmost DETACHED surface (the AccountDialog), while open. Detached
 * surfaces are kept OUT of `activeRouteSurfaces` so `closeAllRouteSurfaces` never
 * touches them — but the AccountDialog IS a valid morph target: a result-bearing
 * flow opened from within it (the account-menu hero avatar → `ChangeAvatar`) must
 * morph INTO it, not stack a new surface behind it. Invariant: whenever set, this
 * surface is frontmost — every account-menu action that opens a tracked surface
 * (Manage, Help, …) dismisses the dialog FIRST, so the two never overlap.
 */
let detachedFrontSurface: TrackedSurface | null = null;

function presentInternal<K extends RouteName>(
  route: K,
  props: Record<string, unknown>,
  opts: PresentOptions | undefined,
  track: boolean,
): SurfaceInstance<K> {
  const navStack = createSurfaceNavStack(route, props);
  const config = getSurfaceConfig(route, props);
  const bloomOpts: PresentOptions = { label: route, ...bloomOptionsFor(config), ...opts };

  // `SurfaceScreen` is statically imported but only READ here, at presentation
  // time. That keeps the surfaces.ts <-> SurfaceScreen cycle safe (a mounted
  // SurfaceScreen imports these presenters, while presenting one renders a
  // SurfaceScreen) without a `require()` — which ESM output must never contain,
  // see the note on `screenComponents` in `./routes`.
  const result = bloomSurfaces.present<SurfaceResult<K>>((surface: SurfaceControls) =>
    createElement(SurfaceScreen, {
      navStack,
      surface,
      dismissOnBackdrop: bloomOpts.dismissOnBackdrop ?? true,
    }),
    bloomOpts,
  );

  const instance: SurfaceInstance<K> = {
    route,
    navigate: (nextRoute, nextProps) => {
      const top = navStack.getTop();
      if (top.route === nextRoute) navStack.replace(nextRoute, nextProps);
      else navStack.navigate(nextRoute, nextProps);
    },
    replace: (nextRoute, nextProps) => navStack.replace(nextRoute, nextProps),
    goBack: () => navStack.goBack(),
    canGoBack: () => navStack.canGoBack(),
    setStep: (step) => navStack.setStep(step),
    beginFlow: (nextRoute, nextProps) => navStack.beginFlow(nextRoute, nextProps),
    dismiss: (dismissResult) => navStack.requestDismiss(dismissResult),
    result,
  };

  // If the surface is torn down (backdrop, `closeAll`, host unmount) while a
  // result-bearing sub-flow is still open, settle that flow so an awaiting caller
  // never hangs. Runs for tracked and detached surfaces alike.
  result.finally(() => navStack.abandonActiveFlow());

  const tracked: TrackedSurface = {
    route: instance.route,
    navigate: instance.navigate,
    goBack: instance.goBack,
    beginFlow: instance.beginFlow,
    dismiss: () => instance.dismiss(),
  };
  if (track) {
    activeRouteSurfaces.push(tracked);
    result.finally(() => {
      const index = activeRouteSurfaces.indexOf(tracked);
      if (index >= 0) activeRouteSurfaces.splice(index, 1);
    });
  } else {
    // Detached (the AccountDialog): NOT in the closeAll lineage, but recorded as
    // the frontmost morph target so a flow opened from within it morphs IN.
    detachedFrontSurface = tracked;
    result.finally(() => {
      if (detachedFrontSurface === tracked) detachedFrontSurface = null;
    });
  }

  return instance;
}

/**
 * Present a NEW route surface on top of the stack (the DEPTH axis). Resolves with
 * the value the surface is dismissed with. Registered in the route-surface stack.
 */
export function present<K extends RouteName>(
  route: K,
  props?: SurfaceProps<K>,
  opts?: PresentOptions,
): SurfaceInstance<K> {
  return presentInternal(route, (props ?? {}) as Record<string, unknown>, opts, true);
}

/**
 * Present a surface that is NOT part of the `showBottomSheet` base-navigation
 * lineage (the AccountDialog modal). Otherwise identical to {@link present}.
 */
export function presentDetached<K extends RouteName>(
  route: K,
  props?: SurfaceProps<K>,
  opts?: PresentOptions,
): SurfaceInstance<K> {
  return presentInternal(route, (props ?? {}) as Record<string, unknown>, opts, false);
}

/**
 * Untyped present for the adapter, the nav helpers, and the `SurfaceScreen`
 * binding (where the route is a runtime value and its props are already erased).
 */
export function presentRoute(route: RouteName, props?: Record<string, unknown>): SurfaceInstance {
  return presentInternal(route, props ?? {}, undefined, true);
}

/** The top-most active route surface, or `undefined` when none are open. */
export function topRouteSurface(): TrackedSurface | undefined {
  return activeRouteSurfaces[activeRouteSurfaces.length - 1];
}

/**
 * The frontmost surface a result-bearing flow should morph INTO: the detached
 * AccountDialog if open (it sits on top of everything), else the top tracked
 * route surface. Used by {@link openWithinOrPresent} so the account-menu hero
 * avatar morphs the dialog into `ChangeAvatar` instead of stacking a new surface.
 */
export function topMorphableSurface(): TrackedSurface | undefined {
  return detachedFrontSurface ?? topRouteSurface();
}

/**
 * Dismiss every active route surface (the whole `showBottomSheet` session). The
 * AccountDialog is untracked, so it is untouched. Iterates a snapshot because
 * `dismiss` mutates `activeRouteSurfaces` asynchronously as surfaces settle.
 */
export function closeAllRouteSurfaces(): void {
  for (const instance of [...activeRouteSurfaces].reverse()) instance.dismiss();
}

/**
 * Drill in from a screen. From inside a surface the DEFAULT is to navigate WITHIN
 * it — the panel MORPHS from the current frame's size to the next's. EVERY screen
 * morphs; a NEW surface is stacked on top ONLY when the target route declares
 * `stacks` (reserved for genuine overlays — none today, since action sheets /
 * confirms / prompts are Bloom-raw `surfaces.present` calls outside this
 * registry). A stacked surface gets its own backdrop + entry animation; dismissing
 * it unwinds back to the surface that opened it.
 */
export function navigateWithinOrPresent(
  navStack: SurfaceNavStack,
  route: RouteName,
  props?: Record<string, unknown>,
): void {
  const nextProps = props ?? {};
  if (getSurfaceConfig(route, nextProps).stacks) {
    presentRoute(route, nextProps);
  } else {
    navStack.navigate(route, nextProps);
  }
}

/** Replace variant of {@link navigateWithinOrPresent} (swaps the top frame). */
export function replaceWithinOrPresent(
  navStack: SurfaceNavStack,
  route: RouteName,
  props?: Record<string, unknown>,
): void {
  const nextProps = props ?? {};
  if (getSurfaceConfig(route, nextProps).stacks) {
    presentRoute(route, nextProps);
  } else {
    navStack.replace(route, nextProps);
  }
}

/**
 * Open a result-bearing route the SAME way a drill-in navigates (the morph-by-
 * default rule), but returning the route's dismissal RESULT to the caller.
 *
 * When a surface is already open and the target morphs into it (the default —
 * anything not marked `stacks`), it runs as a SUB-FLOW inside that surface: the
 * panel morphs from the current screen into the target, and the promise resolves
 * with the target's `dismiss(result)` (or `undefined` when cancelled), popping
 * back to the caller's frame WITHOUT closing the host. Otherwise (no surface, or a
 * route that stacks) it presents a fresh surface and resolves with its dismissal —
 * identical to the historical `present(route).result`.
 *
 * The entry seam for the avatar picker AND its nested "My Oxy files" media
 * selector: each awaits its result whether it morphed into the caller's surface
 * or opened cold, with no morph-vs-present branch of its own.
 */
export function openWithinOrPresent<K extends RouteName>(
  route: K,
  props?: SurfaceProps<K>,
): Promise<SurfaceResult<K> | undefined> {
  const nextProps = (props ?? {}) as Record<string, unknown>;
  const host = topMorphableSurface();
  if (host && !getSurfaceConfig(route, nextProps).stacks) {
    // Morph: run as a sub-flow inside the host. The erased `Promise<unknown>` is
    // narrowed to this route's result at the typed boundary (the sub-flow resolves
    // with exactly the value a descendant screen passes to `dismiss(result)`).
    return host.beginFlow(route, nextProps) as Promise<SurfaceResult<K> | undefined>;
  }
  return present(route, props).result;
}

/**
 * The SDK's imperative surface API (a module singleton). `present` is the typed
 * route presenter; `dismissAll` unwinds the whole session. Not yet exported from
 * the package root — the public `surfaces`/`useSurfaces` API lands in a later
 * phase; for P1 the internal adapters (`showBottomSheet`, `openAccountDialog`)
 * are the only public entry points.
 */
export const surfaces = {
  present: <K extends RouteName>(route: K, props?: SurfaceProps<K>, opts?: PresentOptions) =>
    present(route, props, opts).result,
  dismissAll: closeAllRouteSurfaces,
} as const;

/** Hook form of {@link surfaces} (stable singleton). */
export function useSurfaces(): typeof surfaces {
  return surfaces;
}
