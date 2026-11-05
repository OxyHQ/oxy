/**
 * Geometry of the Commons emblem the hologram engraves in the card's
 * bottom-right corner (`components/holographic-card.tsx`). Shared so the faces
 * keep their text off it. The hologram does not flip with the card, so on the
 * BACK face the emblem shows in the bottom-LEFT corner.
 */
export const EMBLEM_SIZE = 30;
export const EMBLEM_PAD = 16;
/** Air between the emblem and the text beside it. */
export const EMBLEM_GAP = 8;
/** Distance from the card edge that text beside the emblem must start at. */
export const EMBLEM_CLEARANCE = EMBLEM_PAD + EMBLEM_SIZE + EMBLEM_GAP;
