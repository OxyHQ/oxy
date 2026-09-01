import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OxyProvider } from '@oxyhq/services';
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
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <OxyProvider baseURL={config.oxyUrl} clientId={config.clientId} authRedirectUri={config.authRedirectUri} queryClient={queryClient}>
          <AccountProvider>
            <TooltipProvider delayDuration={300}>
              <Outlet />
            </TooltipProvider>
          </AccountProvider>
        </OxyProvider>
      </LocaleProvider>
      {import.meta.env.DEV && (
        <Suspense fallback={null}>
          <TanStackRouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </QueryClientProvider>
  );
}
