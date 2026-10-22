/**
 * Full-screen app-boot splash, macOS-boot styled: a centered Oxy logo above a
 * thin, indeterminate progress bar in the brand colour.
 *
 * This mirrors the inline splash baked into `index.html` (which paints before
 * the JS bundle mounts) so there is no flicker/jump on hand-off to React. Keep
 * the logo size, bar dimensions and animation in sync between the two.
 */
export function SplashScreen() {
  // Single source of truth for the app name is public/manifest.json
  // `short_name`, injected at build time by Vite (see vite.config.ts). Never
  // hardcode it here.
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-6 bg-background">
      <img
        src="/icon-192.png"
        alt="Oxy"
        width={80}
        height={80}
        className="h-20 w-20 rounded-[22px]"
        draggable={false}
      />
      <p className="text-base font-medium text-foreground">{__APP_NAME__}</p>
      <div className="h-[5px] w-40 overflow-hidden rounded-full bg-muted">
        <div className="oxy-splash-bar h-full w-full rounded-full bg-primary" />
      </div>
    </div>
  );
}
