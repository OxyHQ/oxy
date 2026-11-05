import type { FC, ReactNode } from 'react';

/**
 * react-native-macos fork: react-native-keyboard-controller has no macOS
 * implementation and throws when imported without its native module, and a
 * desktop keyboard never covers the window, so there is nothing to track.
 */
export const KeyboardBoundary: FC<{ children: ReactNode }> = ({ children }) => <>{children}</>;
