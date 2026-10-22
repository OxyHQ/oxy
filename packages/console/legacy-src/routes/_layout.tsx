import { Outlet, createFileRoute } from '@tanstack/react-router';
import { RequireOxyAuth, useAuth } from '@oxy.so/services';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { CommandMenuTrigger } from '@/components/command-menu';
import { SplashScreen } from '@/components/splash-screen';
import { SignInScreen } from '@/components/sign-in-screen';

export const Route = createFileRoute('/_layout')({
  component: LayoutComponent,
});

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { signIn } = useAuth();

  // The shared SDK signed-out gate (`RequireOxyAuth prompt="hard"`). It keys on
  // the SDK readiness state (`canUsePrivateApi` / `isPrivateApiPending`), so
  // private data never loads before the device-first cold boot resolves and the
  // signed-out wall never flashes. The console keeps its own branded splash +
  // sign-in screen via the fallbacks; the sign-in button opens the in-app
  // "Sign in with Oxy" dialog (`signIn()` — modal only, never a navigation).
  return (
    <RequireOxyAuth
      prompt="hard"
      loadingFallback={<SplashScreen />}
      signedOutFallback={<SignInScreen onSignIn={() => void signIn()} />}
    >
      {children}
    </RequireOxyAuth>
  );
}

function LayoutComponent() {
  return (
    <AuthGuard>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="flex flex-col h-screen">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <CommandMenuTrigger />
            <div className="flex-1" />
          </header>
          <main className="flex-1 flex flex-col overflow-auto">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </AuthGuard>
  );
}
