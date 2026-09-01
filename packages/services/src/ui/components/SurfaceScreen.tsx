import React, { Suspense, useCallback, useEffect, useMemo, useState, type ErrorInfo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useStore } from 'zustand';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  useDialogFrame,
  useDialogHeader,
  type DialogHeaderConfig,
} from '@oxyhq/bloom/dialog';
import type { SurfaceControls } from '@oxyhq/bloom/surfaces';
import type { RouteName } from '../navigation/routes';
import { getScreenComponent } from '../navigation/routes';
import { pushSurfaceBackHandler } from '../navigation/surfaceBackBridge';
import type { SurfaceNavStack } from '../navigation/surfaceNavStack';
import { getSurfaceConfig } from '../navigation/surfaceRegistry';
import {
  closeAllRouteSurfaces,
  navigateWithinOrPresent,
  presentRoute,
  replaceWithinOrPresent,
} from '../navigation/surfaces';
import {
  SurfaceHeaderContext,
  type SurfaceHeaderContent,
} from '../hooks/useSurfaceHeader';
import type { BaseScreenProps } from '../types/navigation';

/** Error boundary catching screen render failures, so one bad screen cannot blank the surface. */
interface ScreenErrorBoundaryState {
  error: Error | null;
}

class ScreenErrorBoundary extends React.Component<
  { screenName: string; children: React.ReactNode },
  ScreenErrorBoundaryState
> {
  state: ScreenErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ScreenErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (__DEV__) {
      console.error(
        `[SurfaceScreen] Screen "${this.props.screenName}" crashed:`,
        error,
        info.componentStack,
      );
    }
  }

  componentDidUpdate(prevProps: { screenName: string }): void {
    if (prevProps.screenName !== this.props.screenName && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <View style={errorStyles.container}>
          <Text style={errorStyles.title}>Something went wrong</Text>
          {__DEV__ && <Text style={errorStyles.message}>{this.state.error.message}</Text>}
        </View>
      );
    }
    return this.props.children;
  }
}

/** The body fill shared by the two states that replace a screen: crashed, and not loaded yet. */
const errorStyles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  message: { fontSize: 13, textAlign: 'center' },
});

/**
 * Shown while a route's screen module is still loading. Screens are registered
 * as `lazy(() => import(...))` (see `../navigation/routes`), so the very first
 * presentation of a surface can land here for a frame; the surface chrome is
 * already on screen by then, so this fills only the body.
 *
 * Deliberately RN's `ActivityIndicator` rather than `@oxyhq/bloom/loading`,
 * matching `authChooser/requestSurfaces`: Bloom still declares
 * `sideEffects: false`, so its `Loading` can still tree-shake to `undefined` in
 * a rolldown-vite production bundle. Removing that risk from the first frame of
 * every route is not worth a themed spinner.
 */
function ScreenPending() {
  const theme = useTheme();
  return (
    <View style={errorStyles.container}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

export interface SurfaceScreenProps {
  /** This surface's route history (the NAV-WITHIN axis). */
  navStack: SurfaceNavStack;
  /** Bloom's per-surface controls (dismiss / present a child) — the DEPTH axis. */
  surface: SurfaceControls;
  /** Whether backdrop / Escape / back may dismiss at the root frame. Defaults to true. */
  dismissOnBackdrop?: boolean;
}

/**
 * Binds one SDK surface to its content: resolves the lazy screen for the current
 * nav-stack frame and renders it inside the error boundary with the per-surface
 * navigation props. Mounted by `surfaces.present` as the Bloom surface's content.
 *
 * Dismissal is driven through the nav stack's `closing` flag (watched in an
 * effect) rather than a captured-controls call, so a dismiss requested before
 * this surface mounted still resolves the Bloom surface exactly once.
 */
function SurfaceScreen({
  navStack,
  surface,
  dismissOnBackdrop = true,
}: SurfaceScreenProps) {
  const theme = useTheme();
  const state = useStore(navStack.store);
  const top = state.frames[state.frames.length - 1];

  useEffect(() => {
    if (state.closing) surface.dismiss(state.closeResult);
  }, [state.closing, state.closeResult, surface]);

  const ScreenComponent = useMemo(() => getScreenComponent(top.route) ?? null, [top.route]);

  const navigate = useCallback(
    (route: RouteName, props?: Record<string, unknown>) =>
      navigateWithinOrPresent(navStack, route, props),
    [navStack],
  );

  const replace = useCallback(
    (route: RouteName, props?: Record<string, unknown>) =>
      replaceWithinOrPresent(navStack, route, props),
    [navStack],
  );

  // Screens' `dismiss(result)` resolves an active sub-flow (morphed-in avatar
  // picker) back to its caller and pops to its entry frame; with no flow it
  // dismisses the whole surface (a screen presented as its own surface) — the
  // historical behaviour. `navStack.resolveFlowOrDismiss` owns that fork.
  const dismiss = useCallback(
    (result?: unknown) => navStack.resolveFlowOrDismiss(result),
    [navStack],
  );

  const canGoBack = useCallback(() => navStack.canGoBack(), [navStack]);

  const setStep = useCallback((step: number) => navStack.setStep(step), [navStack]);

  // Screen-facing back: pop a frame, else step a wizard back, else dismiss the
  // surface — the exact behaviour the single `BottomSheetRouter` had per session.
  const goBack = useCallback((): void => {
    if (navStack.goBack()) return;
    const current = navStack.getTop();
    if (current.step > 0) {
      navStack.setStep(current.step - 1);
      return;
    }
    navStack.requestDismiss();
  }, [navStack]);

  const handleSystemBack = useCallback((): boolean => {
    if (navStack.goBack()) return true;
    const current = navStack.getTop();
    if (current.step > 0) {
      navStack.setStep(current.step - 1);
      return true;
    }
    if (dismissOnBackdrop) navStack.requestDismiss();
    return true;
  }, [navStack, dismissOnBackdrop]);

  useEffect(() => pushSurfaceBackHandler(handleSystemBack), [handleSystemBack]);

  const present = useCallback(
    (route: RouteName, props?: Record<string, unknown>) => presentRoute(route, props).result,
    [],
  );

  // --- Dialog nav-header wiring ------------------------------------------
  // Screens render NO header of their own: the Dialog owns a sticky gradient nav
  // bar + a large collapsing title. Here the surface HOST supplies the back/close
  // wiring and bridges the mounted screen's runtime contribution (its translated
  // title/subtitle + any action slot, via `useSurfaceHeader`) into the Dialog's
  // header. One writer to Bloom's header store — this merge — so back/close and
  // the screen's content never race.
  const [headerContent, setHeaderContent] = useState<SurfaceHeaderContent | null>(null);
  const headerContext = useMemo(() => ({ setContent: setHeaderContent }), []);

  const config = useMemo(() => getSurfaceConfig(top.route, top.props), [top.route, top.props]);
  const headerMode = config.header;

  // --- Size morphing on nav-within ---------------------------------------
  // The Dialog cannot see a drill-in from its own props (only this host
  // re-renders when the nav stack moves), so it is told which frame is on
  // screen. When that identity changes the surface MORPHS — the panel animates
  // between the two frames' sizes instead of hard-cutting. A wizard step counts
  // as a frame: it swaps the visible content inside one screen the same way.
  // A `stacks` route opens its OWN surface (never a frame here); everything else
  // morphs.
  //
  // A route may declare an EXPLICIT large morph target (`frameSize`) — the media
  // selector's own-scroller grid, which the panel can't measure, grows the
  // container to a near-full-height, wider card and shrinks back on exit. Resolve
  // its viewport-relative height to px here (the Dialog clamps to the viewport).
  const { height: viewportHeight } = useWindowDimensions();
  const frameSize = useMemo(() => {
    const spec = config.frameSize;
    if (!spec) return undefined;
    const height =
      spec.heightRatio !== undefined ? Math.round(viewportHeight * spec.heightRatio) : undefined;
    return { height, maxWidth: spec.maxWidth };
  }, [config.frameSize, viewportHeight]);
  useDialogFrame(
    useMemo(
      () => ({ key: `${top.route}#${top.step}`, morph: config.morph, size: frameSize }),
      [top.route, top.step, config.morph, frameSize],
    ),
  );
  // Show a back affordance whenever the surface can navigate back — either an
  // earlier frame in this surface's stack, or an earlier wizard step.
  const canGoBackNow = state.frames.length > 1 || top.step > 0;

  const dialogHeader = useMemo<DialogHeaderConfig | null>(() => {
    if (!headerMode) return null;
    return {
      largeTitle: true,
      ...headerContent,
      // A screen may own its back (e.g. the account dialog's per-view back via
      // `useSurfaceHeader({ onBack })`); otherwise the surface's nav-stack back
      // drives it (a drilled-in frame / wizard step).
      onBack: headerContent?.onBack ?? (canGoBackNow ? goBack : undefined),
    };
  }, [headerMode, headerContent, canGoBackNow, goBack]);

  useDialogHeader(dialogHeader);

  const screenProps = useMemo<BaseScreenProps>(() => {
    const { initialStep: _omitInitialStep, ...rest } = top.props;
    return {
      // NAV-WITHIN
      navigate,
      goBack,
      replace,
      canGoBack,
      initialStep: top.step,
      step: top.step,
      onStepChange: setStep,
      setStep,
      currentScreen: top.route,
      // DEPTH — `onClose`/`onAuthenticated` unwind the whole session (matching the
      // old `closeBottomSheet`); `dismiss`/`present` are the per-surface controls.
      onClose: closeAllRouteSurfaces,
      onAuthenticated: closeAllRouteSurfaces,
      dismiss,
      present,
      // Theme + the route's own props.
      theme: theme.mode,
      ...rest,
    };
  }, [navigate, goBack, replace, canGoBack, setStep, present, dismiss, theme.mode, top.route, top.step, top.props]);

  if (!ScreenComponent) return null;

  return (
    <SurfaceHeaderContext.Provider value={headerContext}>
      <ScreenErrorBoundary screenName={top.route}>
        <Suspense fallback={<ScreenPending />}>
          <ScreenComponent {...screenProps} />
        </Suspense>
      </ScreenErrorBoundary>
    </SurfaceHeaderContext.Provider>
  );
}

export default SurfaceScreen;
