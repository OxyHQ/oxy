import React, { useMemo, useState, useEffect } from 'react';
import { StyleSheet, RefreshControl, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedScrollHandler,
  runOnJS,
  useAnimatedReaction,
} from 'react-native-reanimated';
import { useScrollContext } from '@/contexts/scroll-context';
import { useColors } from '@/hooks/useColors';

interface ScreenContentWrapperProps {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function ScreenContentWrapper({
  children,
  refreshing = false,
  onRefresh,
}: ScreenContentWrapperProps) {
  const {
    setIsScrolled,
    scrollRef,
    scrollY,
    scrollDirection,
    headerHeight: contextHeaderHeight,
  } = useScrollContext();
  const { width } = useWindowDimensions();
  const colors = useColors();

  // Check if we're on mobile (header is absolutely positioned on mobile)
  const isMobile = Platform.OS !== 'web' || (Platform.OS === 'web' && width < 768);

  const scrollHandler = useAnimatedScrollHandler(
    {
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

        // Update isScrolled state on JS thread
        if (currentY > 10 !== previousY > 10) {
          runOnJS(setIsScrolled)(currentY > 10);
        }
      },
    },
    [],
  );

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
    [contextHeaderHeight],
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
