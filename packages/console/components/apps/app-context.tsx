import { createContext, type ReactNode, useContext } from 'react';

import type { Application, CallerAccess } from '@/hooks/use-applications';

interface AppDetailValue {
  application: Application;
  access: CallerAccess;
}

const AppDetailContext = createContext<AppDetailValue | null>(null);

/** Provided by `app/(shell)/apps/[appId]/_layout.tsx` once the application has loaded. */
export function AppDetailProvider({
  application,
  access,
  children,
}: AppDetailValue & { children: ReactNode }) {
  return (
    <AppDetailContext.Provider value={{ application, access }}>
      {children}
    </AppDetailContext.Provider>
  );
}

/** The loaded application and the caller's access to it, for every `[appId]` section. */
export function useAppDetail(): AppDetailValue {
  const value = useContext(AppDetailContext);
  if (!value) {
    throw new Error('useAppDetail must be used inside the [appId] layout');
  }
  return value;
}
