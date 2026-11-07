/**
 * A platform's own card around the account chooser (`OxyAuthChooser`), as the
 * account dialog is the card around it in an app: OxyOS's login screen shows
 * the SDK's sign-in on a card of its own (OxyOS ADR 0020, decision 4).
 *
 * Inside it the chooser's screens ask for the width their views need exactly as
 * they ask the account dialog (`useSurfaceFrameWidth`: the sign-in's split card,
 * with the Commons QR, asks for 880 from `md`; `null` when no longer needed).
 * The platform sizes its card to the width asked, up to what its screen has.
 */

import type React from 'react';
import { SurfaceFrameWidthContext } from '../hooks/useSurfaceFrameWidth';

export interface OxySurfaceFrameProps {
  /** The width (px, the card's own padding included) a screen inside asks for; `null` for the card's own. */
  onMaxWidthChange: (maxWidth: number | null) => void;
  children: React.ReactNode;
}

export const OxySurfaceFrame: React.FC<OxySurfaceFrameProps> = ({ onMaxWidthChange, children }) => (
  <SurfaceFrameWidthContext.Provider value={onMaxWidthChange}>
    {children}
  </SurfaceFrameWidthContext.Provider>
);
