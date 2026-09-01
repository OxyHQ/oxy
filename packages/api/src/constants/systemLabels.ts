/**
 * The labels every mailbox has.
 *
 * These are part of the product, not user data: the same eight names, colours
 * and order for everyone, referenced by name from `Message.labels` and from the
 * default bundles' `matchLabels`. Writing a copy of them into `labels` for each
 * user bought nothing — the rows were never edited, never differed between
 * accounts, and had to be lazily re-seeded on every write path in case a user
 * had somehow missed them. They live here instead; the collection now holds
 * only the labels a user actually made.
 *
 * `_id` is a stable synthetic id (`system:<name>`) so a client can key a list
 * on it exactly like a real label. It is deliberately not an ObjectId: nothing
 * should be able to look one of these up in the database.
 */

export interface SystemLabel {
  _id: string;
  name: string;
  color: string;
  order: number;
  system: true;
}

/** Prefix of every synthetic system-label id. */
const SYSTEM_ID_PREFIX = 'system:';

/** Whether `labelId` addresses a system label rather than a stored one. */
export function isSystemLabelId(labelId: string): boolean {
  return labelId.startsWith(SYSTEM_ID_PREFIX);
}

const DEFINITIONS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Personal', color: '#1A73E8' },
  { name: 'Work', color: '#34A853' },
  { name: 'Finance', color: '#FBBC04' },
  { name: 'Shopping', color: '#EA4335' },
  { name: 'Travel', color: '#9334E6' },
  { name: 'Social', color: '#E8710A' },
  { name: 'Updates', color: '#607D8B' },
  { name: 'Forums', color: '#795548' },
];

export const SYSTEM_LABELS: ReadonlyArray<SystemLabel> = DEFINITIONS.map((l, order) => ({
  _id: `${SYSTEM_ID_PREFIX}${l.name.toLowerCase()}`,
  name: l.name,
  color: l.color,
  order,
  system: true,
}));

/** Lower-cased system label names, for case-insensitive comparison. */
const SYSTEM_NAMES = new Set(SYSTEM_LABELS.map((l) => l.name.toLowerCase()));

/** Whether `name` is one of the system labels, ignoring case and surrounding space. */
export function isSystemLabel(name: string): boolean {
  return SYSTEM_NAMES.has(name.trim().toLowerCase());
}
