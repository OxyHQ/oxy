import type { RouteName } from '../navigation/routes';
import type { SurfaceProps, SurfaceResult } from '../navigation/surfaceRegistry';

/**
 * The typed prop contract a screen receives when it is bound into an SDK surface.
 *
 * This is the successor to the grab-bag `BaseScreenProps`: `props` carries the
 * route's own {@link SurfaceProps typed props}, and the navigation methods are
 * split along the two axes the surface system models — NAV-WITHIN
 * (`navigate`/`replace`/`goBack`/`step`) inside this surface, and DEPTH
 * (`present`/`dismiss`) across the stack.
 *
 * In P1 the ~35 screens still consume the legacy `BaseScreenProps` shape (the
 * `SurfaceScreen` binding passes a superset that satisfies both), so this type is
 * the target contract for the per-screen migration in a later phase — it is not
 * yet the render-time prop shape for existing screens.
 */
export interface SurfaceScreenProps<K extends RouteName> {
  /** The route's typed props (from the {@link SurfaceProps registry}). */
  props: SurfaceProps<K>;
  /** Drill in to another route — WITHIN this surface, or a new surface if the
   * target's presentation differs. */
  navigate: <T extends RouteName>(route: T, props?: SurfaceProps<T>) => void;
  /** Replace the current route in place (no history entry). */
  replace: <T extends RouteName>(route: T, props?: SurfaceProps<T>) => void;
  /** Pop one level; if at the root, dismiss the surface. */
  goBack: () => void;
  /** Whether a back is possible (a deeper route OR a prior wizard step). */
  canGoBack: () => boolean;
  /** Dismiss THIS surface, resolving its `present()` promise with `result`. */
  dismiss: (result?: SurfaceResult<K>) => void;
  /** Present a NEW surface on top of the stack (DEPTH); resolves with its result. */
  present: <T extends RouteName>(
    route: T,
    props?: SurfaceProps<T>,
  ) => Promise<SurfaceResult<T> | undefined>;
  /** The current wizard step of this frame. */
  step: number;
  /** Set the current wizard step. */
  setStep: (step: number) => void;
}
