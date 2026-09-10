import type { PropsWithChildren, ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollOffset,
} from 'react-native-reanimated';

import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@oxy.so/bloom/theme';
import { useColors } from '@/hooks/useColors';
import { useScrollContext } from '@/contexts/scroll-context';

const HEADER_HEIGHT = 250;

type Props = PropsWithChildren<{
  headerImage: ReactElement;
  headerBackgroundColor: { dark: string; light: string };
}>;

export default function ParallaxScrollView({
  children,
  headerImage,
  headerBackgroundColor,
}: Props) {
  const { mode } = useTheme();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setIsScrolled } = useScrollContext();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollOffset(scrollRef);

  const headerAnimatedStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      scrollOffset.value,
      [-HEADER_HEIGHT, 0, HEADER_HEIGHT],
      [-HEADER_HEIGHT / 2, 0, HEADER_HEIGHT * 0.75]
    );
    const scale = interpolate(
      scrollOffset.value,
      [-HEADER_HEIGHT, 0, HEADER_HEIGHT],
      [2, 1, 1]
    );

    return {
      transform: [{ translateY }, { scale }],
    };
  }, []);

  const headerStyle = useMemo(() => [
    styles.header,
    { backgroundColor: headerBackgroundColor[mode] },
    headerAnimatedStyle,
  ], [mode, headerBackgroundColor, headerAnimatedStyle]);

  const scrollViewStyle = useMemo(() => ({ backgroundColor: colors.background, flex: 1 }), [colors.background]);

  // Header height: safe area top + header top padding (16) + content height (~56) + bottom padding (16)
  const headerContentHeight = 56;
  const headerTopPadding = 16;
  const headerBottomPadding = 16;
  const headerTotalHeight = insets.top + headerTopPadding + headerContentHeight + headerBottomPadding;

  // Handle scroll events
  const handleScroll = (event: { nativeEvent: { contentOffset: { y: number } } }) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    setIsScrolled(offsetY > 10);
  };

  return (
    <Animated.ScrollView
      ref={scrollRef}
      style={scrollViewStyle}
      scrollEventThrottle={16}
      onScroll={handleScroll}
      contentContainerStyle={{ paddingTop: headerTotalHeight }}>
      <Animated.View style={headerStyle}>
        {headerImage}
      </Animated.View>
      <ThemedView style={styles.content}>{children}</ThemedView>
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    height: HEADER_HEIGHT,
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    padding: 32,
    gap: 16,
    overflow: 'hidden',
  },
});
