/**
 * Calendar-date arithmetic that was being hand-written, and half the time
 * written wrong, across repos.
 *
 * Only questions with ONE right answer live here. "Which calendar day is this
 * on, relative to that one?" has one. "How long ago was this?" is elapsed time,
 * and how to round and phrase it (`"3h"`, `"2d ago"`, a locale's relative-time
 * format) is a product decision — those formatters stay where they are.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Whole calendar days from `from` to `to` in LOCAL time: `0` for the same day,
 * `1` for the next, `-1` for the previous. The time of day is ignored — 23:59
 * to 00:01 the next morning is `1`, 00:00 to 23:59 the same day is `0`.
 *
 * This is the "Today / Yesterday / Tomorrow / this week" bucketing every mail,
 * chat and activity list does, and the audit found it written by hand in six
 * repos as `(startOfDay(a) - startOfDay(b)) / 86400000`:
 *
 * - `Inbox` (×4: `MessageRow` twice, `InboxList`, `ReminderRow`) and `oxy`
 *   (`accounts/utils/activity-format.ts`) round it with `Math.floor`;
 * - `Alia` (`message-days.ts`), `Syra` (`RoomCard`), `Peable` (the wallet list)
 *   and `Bloom` (`daysInRange`) round it with `Math.round`, and two of those
 *   say why in a comment.
 *
 * The split is the reason this is shared, the same shape as `clamp`'s `NaN`
 * guard: one rounding is a bug. A local day is not 24 hours on the two days a
 * year the clock changes. Across a spring-forward night, midnight-to-midnight
 * is 23 hours, so `Math.floor(23 / 24)` is `0` — a message from yesterday is
 * filed under "Today", and in `ReminderRow` a reminder for tomorrow reads
 * "Today at 9:00". `Math.round` happens to survive (23h and 25h both round to
 * a whole day); this takes the date parts instead and subtracts them as UTC
 * dates, where every day IS 24 hours, so there is nothing to round away.
 *
 * Not a duration. Mention's drafts list (`"5m"`, `"3h"`, `"2d ago"`) floors
 * raw elapsed milliseconds, and for an elapsed-time label that is right — it
 * stays. Syra's `formatPubDate` does the same but labels the result "Today" /
 * "Yesterday", which names a calendar day: an episode published at 23:00 and
 * read at 08:00 is 9 hours old, floors to `0`, and reads "Today" when it was
 * yesterday. Where a label names a CALENDAR day, use this; where it reports
 * elapsed time, it is not this function's business.
 *
 * An invalid `Date` yields `NaN` rather than throwing. Every caller found feeds
 * the result straight into `=== 0` / `< 7` comparisons, all of which `NaN`
 * fails, so a malformed timestamp falls through to the absolute-date branch
 * (as the hand-written versions already did) instead of throwing out of a list
 * row's render. Callers that must distinguish it check `Number.isNaN`.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end - start) / MS_PER_DAY);
}
