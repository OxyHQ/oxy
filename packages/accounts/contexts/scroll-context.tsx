import React, { createContext, useContext, useState, ReactNode, useRef, useMemo } from 'react';
import Animated, { useSharedValue, SharedValue } from 'react-native-reanimated';

interface ScrollContextType {
  isScrolled: boolean;
  setIsScrolled: React.Dispatch<React.SetStateAction<boolean>>;
  scrollRef: React.RefObject<Animated.ScrollView | null>;
  scrollToTop: () => void;
  scrollY: SharedValue<number>;
  scrollDirection: SharedValue<'up' | 'down'>;
  headerHeight: SharedValue<number>;
}

const ScrollContext = createContext<ScrollContextType | undefined>(undefined);

export function ScrollProvider({ children }: { children: ReactNode }) {
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollRef = useRef<Animated.ScrollView>(null);
  const scrollY = useSharedValue(0);
  const scrollDirection = useSharedValue<'up' | 'down'>('up');
  const headerHeight = useSharedValue(0);

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  const value = useMemo(
    () => ({
      isScrolled,
      setIsScrolled,
      scrollRef,
      scrollToTop,
      scrollY,
      scrollDirection,
      headerHeight,
    }),
    [isScrolled, scrollY, scrollDirection, headerHeight],
  );

  return <ScrollContext.Provider value={value}>{children}</ScrollContext.Provider>;
}

export function useScrollContext() {
  const context = useContext(ScrollContext);
  if (context === undefined) {
    throw new Error('useScrollContext must be used within a ScrollProvider');
  }
  return context;
}
