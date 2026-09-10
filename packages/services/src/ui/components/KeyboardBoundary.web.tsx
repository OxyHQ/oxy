import type { FC, ReactNode } from 'react';

/** Web has no native keyboard-controller lifecycle. */
export const KeyboardBoundary: FC<{ children: ReactNode }> = ({ children }) => <>{children}</>;
