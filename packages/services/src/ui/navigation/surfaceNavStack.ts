import { createStore, type StoreApi } from 'zustand/vanilla';
import type { RouteName } from './routes';

/**
 * Per-surface route history — the NAV-WITHIN axis.
 *
 * Bloom's surface stack owns DEPTH (a surface presented on top of another). This
 * store owns the ORTHOGONAL axis: the route history INSIDE one SDK surface. Each
 * SDK surface holds its own {@link SurfaceNavStack}; `navigate`/`replace`/`goBack`
 * mutate it and the SAME Bloom surface re-renders its content from the new top
 * frame. It is the per-surface reincarnation of the old global
 * `bottomSheetStore`'s `history` + `currentStep`.
 *
 * `closing`/`closeResult` model a pending dismissal: the surface's `SurfaceScreen`
 * watches them and calls the Bloom surface's `dismiss(result)` from an effect —
 * so a dismiss requested BEFORE the surface has mounted still resolves once it
 * does, with no controls-capture race and no render-phase side effect.
 */

/** One frame in a surface's route history. */
export interface NavFrame {
  route: RouteName;
  props: Record<string, unknown>;
  /** Current wizard step for step-based screens (seeded from `props.initialStep`). */
  step: number;
}

export interface NavStackState {
  /** Bottom → top; the last frame is the visible screen. */
  frames: NavFrame[];
  /** Direction of the last in-dialog navigation for Bloom's content transition. */
  direction: 'forward' | 'backward' | 'none';
  /** Flipped once a dismiss is requested; the host resolves the Bloom surface. */
  closing: boolean;
  /** The value the surface's `present()` promise resolves with on dismissal. */
  closeResult: unknown;
}

export interface SurfaceNavStack {
  store: StoreApi<NavStackState>;
  /** Drill in: push a new frame. */
  navigate(route: RouteName, props?: Record<string, unknown>): void;
  /** Swap the top frame in place (no history entry). */
  replace(route: RouteName, props?: Record<string, unknown>): void;
  /** Return to the prior wizard step, then pop a frame. False at the root with no prior step. */
  goBack(): boolean;
  /** Whether a back is possible (a deeper frame OR a prior wizard step). */
  canGoBack(): boolean;
  /** Set the current frame's wizard step. */
  setStep(step: number): void;
  /** Request dismissal of the whole surface, resolving its promise with `result`. */
  requestDismiss(result?: unknown): void;
  /**
   * Begin a result-bearing SUB-FLOW inside this surface: push `route` as a frame
   * and return a promise that settles when the flow finishes — a descendant's
   * `dismiss(result)` resolves it with `result`, backing out of the flow's entry
   * frame resolves it with `undefined` (cancelled) — popping the surface back to
   * the frame that started the flow WITHOUT dismissing it. This is how a screen
   * already living inside a surface (EditProfile, ManageAccount) opens the avatar
   * flow as a MORPH instead of a stacked surface while still awaiting its result.
   * The avatar flow is ONE flow (`ChangeAvatar`) with plain forward frames pushed
   * on top (the "My Oxy files" `FileManagement` picker, then `AvatarCrop`); the
   * cropper's `dismiss(result)` resolves THIS flow. Flows are kept as a STACK so
   * they can nest generically, even though no current caller opens a flow inside
   * another.
   */
  beginFlow(route: RouteName, props?: Record<string, unknown>): Promise<unknown>;
  /**
   * Resolve the INNERMOST active sub-flow with `result` and pop back to its entry
   * (the frame that called {@link beginFlow}), leaving the surface open. With NO
   * active flow this falls back to {@link requestDismiss} — so a screen presented
   * as its OWN surface still dismisses it. Wired to every screen's `dismiss` prop.
   */
  resolveFlowOrDismiss(result?: unknown): void;
  /** Settle EVERY still-pending sub-flow with `undefined` (the surface is going away). */
  abandonActiveFlow(): void;
  /** The current (top) frame. */
  getTop(): NavFrame;
}

function makeFrame(route: RouteName, props?: Record<string, unknown>): NavFrame {
  const resolved = props ?? {};
  const step = typeof resolved.initialStep === 'number' ? resolved.initialStep : 0;
  return { route, props: resolved, step };
}

export function createSurfaceNavStack(
  route: RouteName,
  props?: Record<string, unknown>,
): SurfaceNavStack {
  const store = createStore<NavStackState>(() => ({
    frames: [makeFrame(route, props)],
    direction: 'none',
    closing: false,
    closeResult: undefined,
  }));

  const getTop = (): NavFrame => {
    const { frames } = store.getState();
    return frames[frames.length - 1];
  };

  // Result-bearing sub-flows currently running in this surface (e.g. the morphed-
  // in avatar flow, whose `ChangeAvatar → FileManagement picker → AvatarCrop`
  // frames are plain forward pushes ON TOP of the ONE flow entry frame). Held as a
  // STACK so flows can nest generically, and OUTSIDE the store (resolvers are
  // functions; flow presence must not re-render frames). Each flow's `returnLength`
  // is the frame count BEFORE its entry frame was pushed, so settling pops back to
  // exactly the frame that started it. `flowStack` is ordered outer → inner; the
  // top is the innermost.
  const flowStack: { returnLength: number; resolve: (result: unknown) => void }[] = [];

  const requestDismiss = (result?: unknown): void => {
    // Dismissing the whole surface abandons EVERY pending sub-flow — settle each
    // promise so an awaiting caller (the avatar picker) never hangs.
    while (flowStack.length) flowStack.pop()?.resolve(undefined);
    if (store.getState().closing) return;
    store.setState({ closing: true, closeResult: result });
  };

  const goBack = (): boolean => {
    const { frames } = store.getState();
    const current = frames[frames.length - 1];
    if (current.step > 0) {
      store.setState({
        frames: [...frames.slice(0, -1), { ...current, step: current.step - 1 }],
        direction: 'backward',
      });
      return true;
    }
    if (frames.length <= 1) return false;
    const nextLength = frames.length - 1;
    store.setState({ frames: frames.slice(0, -1), direction: 'backward' });
    // Backing out past a sub-flow's entry frame cancels it (resolve undefined).
    // A single pop crosses at most one boundary, but loop for safety.
    while (flowStack.length && nextLength <= flowStack[flowStack.length - 1].returnLength) {
      flowStack.pop()?.resolve(undefined);
    }
    return true;
  };

  return {
    store,
    getTop,
    requestDismiss,
    goBack,
    navigate(nextRoute, nextProps) {
      store.setState((state) => ({
        frames: [...state.frames, makeFrame(nextRoute, nextProps)],
        direction: 'forward',
      }));
    },
    replace(nextRoute, nextProps) {
      store.setState((state) => ({
        frames: [...state.frames.slice(0, -1), makeFrame(nextRoute, nextProps)],
        direction: 'forward',
      }));
    },
    canGoBack() {
      const { frames } = store.getState();
      return frames.length > 1 || (frames[frames.length - 1]?.step ?? 0) > 0;
    },
    setStep(step) {
      store.setState((state) => {
        const frames = state.frames.slice();
        const index = frames.length - 1;
        const direction =
          step === frames[index].step
            ? state.direction
            : step < frames[index].step
              ? 'backward'
              : 'forward';
        frames[index] = { ...frames[index], step };
        return { frames, direction };
      });
    },
    beginFlow(nextRoute, nextProps) {
      const returnLength = store.getState().frames.length;
      store.setState((state) => ({
        frames: [...state.frames, makeFrame(nextRoute, nextProps)],
        direction: 'forward',
      }));
      return new Promise<unknown>((resolve) => {
        flowStack.push({ returnLength, resolve });
      });
    },
    resolveFlowOrDismiss(result) {
      const flow = flowStack.pop();
      if (!flow) {
        // No flow → this screen owns its surface; dismiss it as before.
        requestDismiss(result);
        return;
      }
      store.setState((state) => ({
        frames: state.frames.slice(0, flow.returnLength),
        direction: 'backward',
      }));
      flow.resolve(result);
    },
    abandonActiveFlow() {
      while (flowStack.length) flowStack.pop()?.resolve(undefined);
    },
  };
}
