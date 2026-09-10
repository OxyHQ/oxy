import type { FC, ReactNode } from 'react';

/** Non-native fallback used by TypeScript, SSR and resolvers without platforms. */
export const KeyboardBoundary: FC<{ children: ReactNode }> = ({ children }) => <>{children}</>;
