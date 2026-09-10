import type { FC, ReactNode } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';

/** Native keyboard integration is an explicit, statically checked dependency. */
export const KeyboardBoundary: FC<{ children: ReactNode }> = ({ children }) => (
  <KeyboardProvider>{children}</KeyboardProvider>
);
