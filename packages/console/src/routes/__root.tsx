import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { OxyProvider } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { ConnectionStatusToasts } from '@oxyhq/bloom/connection-status';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AccountProvider } from '@/hooks/use-account';
import { LocaleProvider } from '@/lib/i18n';

import config from '@/lib/config';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 30,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    },
    mutations: {
      retry: 1,
    },
  },
});

const TanStackRouterDevtools = lazy(() =>
  import('@tanstack/react-router-devtools').then((mod) => ({
    default: mod.TanStackRouterDevtools,
  }))
);

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  // `OxyProvider` owns the one `QueryClientProvider` for the tree — handing it
  // the app's client is what makes the SDK's account hooks and Console's own
  // hooks share a single cache. Wrapping it in a second provider around the
  // same instance added a layer and no behaviour; nothing outside `OxyProvider`
  // here uses React Query.
  return (
    <LocaleProvider>
      <BloomThemeProvider mode="system" colorPreset="oxy">
        <ConnectionStatusToasts />
        <OxyProvider baseURL={config.oxyUrl} clientId={config.clientId} authRedirectUri={config.authRedirectUri} queryClient={queryClient}>
          <AccountProvider>
            <TooltipProvider delayDuration={300}>
              <Outlet />
            </TooltipProvider>
          </AccountProvider>
          {import.meta.env.DEV && (
            <Suspense fallback={null}>
              <TanStackRouterDevtools position="bottom-right" />
            </Suspense>
          )}
        </OxyProvider>
      </BloomThemeProvider>
    </LocaleProvider>
  );
}
