/**
 * Branded, logged-out sign-in screen.
 *
 * Shown by the `AuthGuard` when the SDK cold boot has resolved and the device
 * has no session. The button opens the in-app "Sign in with Oxy" modal
 * (`signIn()` — modal only, no navigation).
 *
 * Mirrors `SplashScreen`'s macOS-boot styling (centered Oxy logo + app name) so
 * the hand-off from the boot splash to this screen has no visual jump.
 */
import { Button } from '@/components/ui/button';

export function SignInScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <img
        src="/icon-192.png"
        alt="Oxy"
        width={80}
        height={80}
        className="h-20 w-20 rounded-[22px]"
        draggable={false}
      />
      <div className="flex flex-col gap-1.5">
        {/* App name comes from public/manifest.json via Vite, like SplashScreen. */}
        <p className="text-lg font-semibold text-foreground">{__APP_NAME__}</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Sign in with your Oxy account to continue.
        </p>
      </div>
      <Button size="lg" className="min-w-48" onClick={onSignIn}>
        Sign in with Oxy
      </Button>
    </div>
  );
}
