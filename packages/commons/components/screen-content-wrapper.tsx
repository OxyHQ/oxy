import React, { useMemo, useState, useEffect } from 'react';
import { StyleSheet, RefreshControl, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedScrollHandler, runOnJS, useAnimatedReaction } from 'react-native-reanimated';
import { setMinimized, useMinimizeState } from '@oxy.so/bloom/tab-bar';
import { useScrollContext } from '@/contexts/scroll-context';
import { useColors } from '@/hooks/useColors';

/** Scroll offset below which the tab bar is always expanded (px). */
const MINIMIZE_TOP_ZONE = 24;
/** Per-event scroll delta that counts as a deliberate direction change (px). */
const MINIMIZE_DIRECTION_THRESHOLD = 3;

interface ScreenContentWrapperProps {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function ScreenContentWrapper({ children, refreshing = false, onRefresh }: ScreenContentWrapperProps) {
  const { setIsScrolled, scrollRef, scrollY, scrollDirection, headerHeight: contextHeaderHeight } = useScrollContext();
  const { width } = useWindowDimensions();
  const colors = useColors();

  // Check if we're on mobile (header is absolutely positioned on mobile)
  const isMobile = Platform.OS !== 'web' || (Platform.OS === 'web' && width < 768);

  // The floating tab bar minimizes as this scroller moves. Bloom ships
  // `useMinimizeOnScroll()` for exactly this, but it returns a SECOND
  // `useAnimatedScrollHandler` and this ScrollView already has one — two
  // handlers cannot both own `onScroll`. So the signal is driven from the
  // handler that is already here, using Bloom's `setMinimized`, which no-ops
  // when the spring is already heading to the requested target and therefore
  // never restarts (and visibly stutters) mid-scroll.
  const minimizeState = useMinimizeState();

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const currentY = event.contentOffset.y;
      const previousY = scrollY.value;

      scrollY.value = currentY;

      // Determine scroll direction
      if (currentY > previousY) {
        scrollDirection.value = 'down';
      } else if (currentY < previousY) {
        scrollDirection.value = 'up';
      }

      // Clamp to the scrollable range so rubber-band overscroll can't flip the
      // direction for a frame and flicker the bar.
      const maxY = Math.max(event.contentSize.height - event.layoutMeasurement.height, 0);
      const clampedY = Math.min(Math.max(currentY, 0), maxY);
      const delta = clampedY - Math.min(Math.max(previousY, 0), maxY);

      if (clampedY < MINIMIZE_TOP_ZONE) {
        setMinimized(minimizeState, 0);
      } else if (delta > MINIMIZE_DIRECTION_THRESHOLD) {
        setMinimized(minimizeState, 1);
      } else if (delta < -MINIMIZE_DIRECTION_THRESHOLD) {
        setMinimized(minimizeState, 0);
      }

      // Update isScrolled state on JS thread
      if (currentY > 10 !== (previousY > 10)) {
        runOnJS(setIsScrolled)(currentY > 10);
      }
    },
  }, [minimizeState]);

  const insets = useSafeAreaInsets();
  
  // Sync header height from shared value to state for use in styles
  // Use a conservative initial estimate: safe area + top padding (10) + top row (menu button 24px + padding 10px top + 10px bottom = 44px) + bottom padding (10) = ~64 + safe area
  // This will be updated immediately when the header measures its actual height
  const initialHeaderHeight = insets.top + 10 + 44 + 10;
  const [headerHeight, setHeaderHeight] = useState(initialHeaderHeight);
  
  useAnimatedReaction(
    () => contextHeaderHeight.value,
    (height) => {
      if (height > 0) {
        runOnJS(setHeaderHeight)(height);
      }
    },
    [contextHeaderHeight]
  );
  
  // Also check the shared value on mount in case it was already set
  useEffect(() => {
    if (contextHeaderHeight.value > 0) {
      setHeaderHeight(contextHeaderHeight.value);
    }
  }, []);

  const contentContainerStyle = useMemo(() => {
    return [
      styles.contentContainer,
      isMobile
        ? {
            paddingTop: headerHeight,
          }
        : // Desktop web: this single scroller now owns the insets that the
          // (tabs) layout's outer container used to apply (paddingTop:88 to
          // clear the fixed Header, 24px horizontal/bottom gutter).
          styles.desktopContentPadding,
    ];
  }, [isMobile, headerHeight]);

  return (
    <Animated.ScrollView
      ref={scrollRef}
      style={styles.scrollView}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
      onScroll={scrollHandler}
      scrollEventThrottle={16}
      nestedScrollEnabled={true}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentInset={{ top: 0, bottom: 0, left: 0, right: 0 }}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.tint}
            colors={[colors.tint]}
            progressViewOffset={isMobile ? headerHeight + 8 : 8}
            progressBackgroundColor={colors.background}
          />
        ) : undefined
      }
    >
      {children}
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
    paddingBottom: 20,
  },
  desktopContentPadding: {
    paddingTop: 88,
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
});

