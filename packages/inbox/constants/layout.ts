/**
 * Layout scale for the message surfaces (inbox rows, Today cards, the Today
 * feed).
 *
 * These exist so alignment is a property of the system rather than of each
 * component: a row, a card header and a card item all inset by `SPACING.lg`.
 * Changing the rhythm means changing it here, once.
 */

/** 4dp-based spacing steps. Anything in between is a bug, not a decision. */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

/** Avatar diameter in a message row. */
export const AVATAR_SIZE = 24;

/** Radii, from the tightest (chips) to the widest (cards). */
export const RADIUS = {
  chip: 10,
  row: 12,
  card: 16,
} as const;

/** Fixed width for the trailing timestamp, so times never ragged-edge. */
export const TIMESTAMP_WIDTH = 64;

/**
 * Readable column width for the message list. Without the detail pane beside
 * it the list would otherwise stretch across an entire desktop display, which
 * leaves the timestamp an arm's length from the sender.
 */
export const CONTENT_MAX_WIDTH = 760;
