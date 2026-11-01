import React, { useCallback, useEffect, useMemo, useState, type ErrorInfo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { useStore } from 'zustand';
import { useOverlayLayerContext, isTopmostOverlayLayer } from '@oxy.so/bloom/overlay';
import { useTheme } from '@oxy.so/bloom/theme';
import { useDialogFrame, useDialogHeader, type DialogHeaderConfig } from '@oxy.so/bloom/dialog';
import type { SurfaceControls } from '@oxy.so/bloom/surfaces';
import type { RouteName } from '../navigation/routes';
import { getScreenComponent, loadScreens, screensReady } from '../navigation/routes';
import { pushSurfaceBackHandler } from '../navigation/surfaceBackBridge';
import type { SurfaceNavStack } from '../navigation/surfaceNavStack';
import { getSurfaceConfig } from '../navigation/surfaceRegistry';
import { SurfaceHeaderContext, type SurfaceHeaderContent } from '../hooks/useSurfaceHeader';
import { SurfaceFrameWidthContext } from '../hooks/useSurfaceFrameWidth';
import type { BaseScreenProps } from '../types/navigation';
import { useI18n } from '../hooks/useI18n';

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

function ScreenLoadState({ failed, retry }: { failed: boolean; retry: () => void }) {
  const { t } = useI18n();
  return (
    <View style={loadingStyles.container}>
      {failed ? (
        <>
          <Text>{t('signin.errors.generic')}</Text>
          <Button onPress={retry}>{t('common.actions.tryAgain')}</Button>
        </>
      ) : (
        <Loading variant="spinner" accessibilityLabel={t('common.status.loading')} />
      )}
    </View>
  );
}

const loadingStyles = StyleSheet.create({
  container: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
});

export interface SurfaceNavigationActions {
  closeAllRouteSurfaces: typeof import('../navigation/surfaces').closeAllRouteSurfaces;
  navigateWithinOrPresent: typeof import('../navigation/surfaces').navigateWithinOrPresent;
  presentRoute: typeof import('../navigation/surfaces').presentRoute;
  replaceWithinOrPresent: typeof import('../navigation/surfaces').replaceWithinOrPresent;
}

export interface SurfaceScreenProps {
  navigation: SurfaceNavigationActions;
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
  navigation,
  dismissOnBackdrop = true,
}: SurfaceScreenProps) {
  const { closeAllRouteSurfaces, navigateWithinOrPresent, presentRoute, replaceWithinOrPresent } =
    navigation;
  const theme = useTheme();
  const overlayLayer = useOverlayLayerContext();
  const state = useStore(navStack.store);
  const top = state.frames[state.frames.length - 1];

  useEffect(() => {
    if (state.closing) surface.dismiss(state.closeResult);
  }, [state.closing, state.closeResult, surface]);

  const [loadState, setLoadState] = useState<'loading' | 'failed' | 'ready'>(() =>
    screensReady() ? 'ready' : 'loading',
  );
  useEffect(() => {
    if (loadState !== 'loading' || state.closing) return;
    let active = true;
    void loadScreens().then(
      () => {
        if (active) setLoadState('ready');
      },
      () => {
        if (active) setLoadState(screensReady() ? 'ready' : 'failed');
      },
    );
    return () => {
      active = false;
    };
  }, [loadState, state.closing]);
  const retryLoad = useCallback(() => setLoadState('loading'), []);

  const ScreenComponent = loadState === 'ready' ? (getScreenComponent(top.route) ?? null) : null;

  const navigate = useCallback(
    (route: RouteName, props?: Record<string, unknown>) =>
      navigateWithinOrPresent(navStack, route, props),
    [navStack, navigateWithinOrPresent],
  );

  const replace = useCallback(
    (route: RouteName, props?: Record<string, unknown>) =>
      replaceWithinOrPresent(navStack, route, props),
    [navStack, replaceWithinOrPresent],
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

  // Screen-facing back: step a wizard back, else pop a frame, else dismiss the
  // surface — the exact behaviour the single `BottomSheetRouter` had per session.
  const goBack = useCallback((): void => {
    if (navStack.goBack()) return;
    navStack.requestDismiss();
  }, [navStack]);

  const present = useCallback(
    (route: RouteName, props?: Record<string, unknown>) => presentRoute(route, props).result,
    [presentRoute],
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
  //
  // A screen may also ask for a width of its own (`useSurfaceFrameWidth`) when
  // its views differ in width; the width joins the frame's identity so each
  // change morphs.
  const [screenWidth, setScreenWidth] = useState<number | null>(null);
  const frameSize = useMemo(() => {
    const spec = config.frameSize;
    if (!spec && screenWidth === null) return undefined;
    const height =
      spec?.heightRatio !== undefined ? Math.round(viewportHeight * spec.heightRatio) : undefined;
    return { height, maxWidth: screenWidth ?? spec?.maxWidth };
  }, [config.frameSize, viewportHeight, screenWidth]);
  useDialogFrame(
    useMemo(
      () => ({
        key: `${top.route}#${top.step}#${screenWidth ?? ''}`,
        morph: config.morph,
        colorPreset: config.colorPreset,
        typography: config.typography,
        direction: state.direction,
        size: frameSize,
      }),
      [
        top.route,
        top.step,
        screenWidth,
        config.morph,
        config.colorPreset,
        config.typography,
        frameSize,
        state.direction,
      ],
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

  // Hardware/browser back follows the same visible affordance, including local
  // account/wizard history, before considering root dismissal.
  const handleSystemBack = useCallback((): boolean => {
    // A standalone sheet or menu above this dialog owns Back/Escape.
    if (!isTopmostOverlayLayer(overlayLayer)) return false;
    if (dialogHeader?.onBack) dialogHeader.onBack();
    else if (!navStack.goBack() && dismissOnBackdrop) navStack.requestDismiss();
    return true;
  }, [dialogHeader?.onBack, navStack, dismissOnBackdrop, overlayLayer]);
  useEffect(() => pushSurfaceBackHandler(handleSystemBack), [handleSystemBack]);

  const closeSession = useCallback(() => {
    // A menu-owned detached host may now contain any SDK route. Its explicit
    // close action must dismiss that host as well as the tracked session.
    navStack.requestDismiss();
    closeAllRouteSurfaces();
  }, [navStack, closeAllRouteSurfaces]);

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
      onClose: closeSession,
      onAuthenticated: closeSession,
      dismiss,
      present,
      // Theme + the route's own props.
      theme: theme.mode,
      ...rest,
    };
  }, [
    closeSession,
    navigate,
    goBack,
    replace,
    canGoBack,
    setStep,
    present,
    dismiss,
    theme.mode,
    top.route,
    top.step,
    top.props,
  ]);

  if (loadState !== 'ready')
    return <ScreenLoadState failed={loadState === 'failed'} retry={retryLoad} />;
  if (!ScreenComponent) return null;

  return (
    <SurfaceHeaderContext.Provider value={headerContext}>
      <SurfaceFrameWidthContext.Provider value={setScreenWidth}>
        <ScreenErrorBoundary screenName={top.route}>
          <ScreenComponent {...screenProps} />
        </ScreenErrorBoundary>
      </SurfaceFrameWidthContext.Provider>
    </SurfaceHeaderContext.Provider>
  );
}

export default SurfaceScreen;
