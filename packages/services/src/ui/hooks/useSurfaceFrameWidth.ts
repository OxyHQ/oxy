import { createContext, useContext, useLayoutEffect } from 'react';

/**
 * A screen's say in how wide its surface is.
 *
 * `SurfaceScreen` is the ONE host that declares the surface's dialog frame, so
 * a screen whose views need different widths (the account dialog: the 420 menu,
 * the sign-in's 880 split card) hands its width to that host rather than
 * declaring a second frame. A change morphs the centered card to it.
 */
export const SurfaceFrameWidthContext = createContext<((maxWidth: number | null) => void) | null>(null);

/** Ask the surface for `maxWidth` (px) while this is mounted; `null` keeps the surface's own. */
export function useSurfaceFrameWidth(maxWidth: number | null): void {
  const setWidth = useContext(SurfaceFrameWidthContext);
  useLayoutEffect(() => {
    if (!setWidth) return;
    setWidth(maxWidth);
    return () => setWidth(null);
  }, [setWidth, maxWidth]);
}
