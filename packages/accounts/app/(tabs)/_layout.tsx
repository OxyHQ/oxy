import { Slot, useRouter, usePathname } from 'expo-router';
import { Drawer } from 'expo-router/drawer';
import React, { useRef, useCallback, useState } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions, TextInput, TouchableOpacity, type ViewStyle } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { useColors } from '@/hooks/useColors';
import { useThemeMode } from '@/contexts/theme-mode-context';
import { DesktopSidebar, DrawerContent, BottomActionBar } from '@/components/ui';
import { Header } from '@/components/header';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useScrollContext } from '@/contexts/scroll-context';
import { useOxy } from '@oxyhq/services';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useSearchNavigation } from '@/hooks/use-search-navigation';
import { useTranslation } from '@/lib/i18n';
import { ErrorFallback } from '@/components/error-fallback';
import { DRAWER_SCREENS } from '@/constants/drawer-screens';
import { floatingPosition } from '@/constants/styles';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  interpolateColor,
  runOnJS,
} from 'react-native-reanimated';

const THEME_TRANSITION_MS = 280;

/** Hides a drawer item from the rail while keeping its route registered. */
const HIDDEN_DRAWER_ITEM: { drawerItemStyle: ViewStyle } = {
  drawerItemStyle: { display: 'none' },
};

export default function TabLayout() {
  const { mode } = useTheme();
  const { toggleTheme } = useThemeMode();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const { t } = useTranslation();

  // Auth gate: the entire `(tabs)` group is a protected zone. Unauthenticated
  // users belong in `(auth)`. We derive the redirect during render (no
  // useEffect) so the protected screens never mount with `user === undefined`,
  // which avoids any TanStack queries firing with no session and the
  // associated "loading forever" UX. We render a neutral spinner during the
  // initial `isLoading` window so a freshly-launched authenticated user
  // doesn't briefly bounce through `(auth)`.
  const { isAuthenticated, isLoading: authLoading, showBottomSheet, refreshSessions } = useOxy();

  // --- Animated background color transition ---
  const prevBgRef = useRef(colors.background);
  const bgProgress = useSharedValue(1);

  // When background color changes, animate from old -> new
  if (prevBgRef.current !== colors.background) {
    prevBgRef.current = colors.background;
    bgProgress.value = 0;
    bgProgress.value = withTiming(1, { duration: THEME_TRANSITION_MS });
  }

  // Capture current colors as shared values so the worklet can access them
  const fromColor = useSharedValue(colors.background);
  const toColor = useSharedValue(colors.background);

  // Update shared values when colors change (runs during render, before layout)
  if (toColor.value !== colors.background) {
    fromColor.value = toColor.value;
    toColor.value = colors.background;
  }

  const animatedBgStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(bgProgress.value, [0, 1], [fromColor.value, toColor.value]),
  }));

  const searchInputRef = useRef<TextInput>(null);

  // Use custom hook for search navigation management (has side effects)
  useSearchNavigation({ searchInputRef });
  const { scrollToTop, scrollY } = useScrollContext();
  const [showGoToTopButton, setShowGoToTopButton] = useState(false);

  const handlePressIn = useHapticPress();

  const handleReload = useCallback(async () => {
    if (!refreshSessions) return;
    try {
      await refreshSessions();
    } catch {
      // Refresh failed — swallow silently; the user can retry
    }
  }, [refreshSessions]);

  const handleDevices = useCallback(() => {
    showBottomSheet?.('ManageAccount');
  }, [showBottomSheet]);

  const handleScanQR = useCallback(() => {
    router.push('/(tabs)/scan-qr');
  }, [router]);

  const handleGoToTop = useCallback(() => {
    scrollToTop();
  }, [scrollToTop]);

  const toggleColorScheme = useCallback(() => {
    toggleTheme();
  }, [toggleTheme]);

  // Update showGoToTopButton state using runOnJS to avoid reading .value during render
  const updateShowGoToTopButton = useCallback((shouldShow: boolean) => {
    setShowGoToTopButton(shouldShow);
  }, []);

  // Determine if FAB should show scan or go to top based on scroll position
  const showGoToTop = useDerivedValue(() => {
    const shouldShow = scrollY.value > 100; // Show go to top after scrolling 100px
    runOnJS(updateShowGoToTopButton)(shouldShow);
    return shouldShow;
  }, [updateShowGoToTopButton]);

  // Animated styles for FAB icon transition
  const fabIconAnimatedStyle = useAnimatedStyle(() => {
    const showTop = showGoToTop.value;
    return {
      opacity: withTiming(showTop ? 1 : 0, { duration: 200 }),
      transform: [{ scale: withTiming(showTop ? 1 : 0.8, { duration: 200 }) }],
    };
  }, []);

  const scanIconAnimatedStyle = useAnimatedStyle(() => {
    const showTop = showGoToTop.value;
    return {
      opacity: withTiming(showTop ? 0 : 1, { duration: 200 }),
      transform: [{ scale: withTiming(showTop ? 0.8 : 1, { duration: 200 }) }],
    };
  }, []);

  // Protected zone. The root Stack (`app/_layout.tsx`) is the SOLE authority
  // for the `(auth)`↔`(tabs)` swap and only mounts this group once the session
  // is resolved AND authenticated, so in steady state the user is always
  // signed in here. The branches below are defensive for the brief transition
  // frame around a sign-out: render a neutral backdrop (NOT a cross-group
  // <Redirect>) so we never compete with the root for the swap — a second
  // authority on the same signal is the documented blank-screen race.
  if (authLoading && !isAuthenticated) {
    return (
      <Animated.View style={[styles.container, animatedBgStyle, styles.gateCenter]}>
        <Loading variant="spinner" size="large" color={colors.tint} />
      </Animated.View>
    );
  }
  if (!isAuthenticated) {
    return <Animated.View style={[styles.container, animatedBgStyle]} />;
  }

  if (isDesktop) {
    return (
      <Animated.View style={[styles.container, animatedBgStyle]}>
        <Header />

        <View style={styles.desktopBody}>
          <View style={styles.desktopSidebarColumn}>
            <DesktopSidebar />
          </View>
          <View style={styles.desktopContentColumn}>
            <View style={styles.desktopContentWrapper}>
              <View style={styles.desktopMain}>
                <Slot />
              </View>
            </View>
          </View>
        </View>

        <BottomActionBar
          variant="desktop"
          mode={mode}
          onReload={handleReload}
          onDevices={handleDevices}
          onToggleTheme={toggleColorScheme}
          onScanQR={handleScanQR}
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.mobileContainer, animatedBgStyle]}>
      <Drawer
        drawerContent={(props) => <DrawerContent {...props} />}
        screenOptions={{
          headerShown: true,
          header: () => <Header />,
          headerTransparent: true,
          headerStyle: {
            backgroundColor: 'transparent',
            height: 0,
          },
          drawerStyle: {
            backgroundColor: 'transparent',
          },
        }}
      >
        {DRAWER_SCREENS.map((screen) => {
          // Screens flagged `platform: 'native'` are not registered on web.
          if (screen.platform === 'native' && Platform.OS === 'web') {
            return null;
          }
          return (
            <Drawer.Screen
              key={screen.name}
              name={screen.name}
              options={{
                ...(screen.labelKey ? { drawerLabel: t(screen.labelKey) } : null),
                ...(screen.titleKey ? { title: t(screen.titleKey) } : null),
                ...(screen.hidden ? HIDDEN_DRAWER_ITEM : null),
                ...(screen.headerShown === false ? { headerShown: false } : null),
              }}
            />
          );
        })}
      </Drawer>

      {/* Bottom actions - Mobile: keep parity with desktop quick actions */}
      <BottomActionBar
        variant="mobile"
        mode={mode}
        onReload={handleReload}
        onDevices={handleDevices}
        onToggleTheme={toggleColorScheme}
        onScanQR={handleScanQR}
      />

      {/* FAB Button - Mobile - Changes between Scan and Go to Top */}
      {Platform.OS !== 'web' && !pathname.includes('scan-qr') && (
        <View style={[styles.fabButton, floatingPosition]}>
          <TouchableOpacity
            style={styles.circleButton}
            onPressIn={handlePressIn}
            onPress={showGoToTopButton ? handleGoToTop : handleScanQR}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={showGoToTopButton ? t('a11y.scrollToTop') : t('a11y.scanQr')}
          >
            <View style={[styles.fabIconContainer, { backgroundColor: mode === 'dark' ? colors.text : colors.background }]}>
              {/* Scan Icon - shown when at top */}
              <Animated.View style={[styles.fabIconAbsolute, scanIconAnimatedStyle]}>
                <MaterialCommunityIcons name="qrcode-scan" size={26} color={mode === 'dark' ? colors.background : colors.text} />
              </Animated.View>
              {/* Go to Top Icon - shown when scrolling */}
              <Animated.View style={[styles.fabIconAbsolute, fabIconAnimatedStyle]}>
                <MaterialCommunityIcons name="arrow-up" size={26} color={mode === 'dark' ? colors.background : colors.text} />
              </Animated.View>
            </View>
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  );
}

/**
 * Route-level error boundary. expo-router calls this when a render error
 * bubbles up from any screen inside `(tabs)`. Keeps the user on the route
 * with a retry action instead of falling back to the LogBox screen.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  mobileContainer: {
    flex: 1,
    position: 'relative',
  },
  gateCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  desktopBody: {
    flex: 1,
    flexDirection: 'row',
  },
  desktopSidebarColumn: {
    minWidth: 350,
    alignItems: 'flex-start',
  },
  desktopContentColumn: {
    flex: 1,
    alignItems: 'center',
  },
  desktopContentWrapper: {
    width: '100%',
    maxWidth: 800,
    flex: 1,
  },
  desktopMain: {
    flex: 1,
    // Allow this flex column to shrink below its content's intrinsic height so
    // the inner ScreenContentWrapper scroller (flex:1) can size against it and
    // own the scroll. Without minHeight:0 the column refuses to shrink and the
    // single scroller collapses to height 0 -> blank page on desktop web.
    minHeight: 0,
  },
  circleButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabButton: {
    bottom: 32,
    right: 32,
    zIndex: 1000,
  },
  fabIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: {
          width: 0,
          height: 4,
        },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: {
        elevation: 8,
      },
      web: {
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
      },
    }),
  },
  fabIconAbsolute: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
