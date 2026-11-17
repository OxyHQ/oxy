/**
 * Age bands (ADR 0067): the one answer every Oxy app gets to "how old is this
 * person, as far as protection goes".
 *
 * A band is DERIVED from the account's date of birth on every read and never
 * stored: it changes on a birthday without any write touching the row. An
 * application never receives the date itself, only the band.
 *
 * - `under13`: below {@link MINIMUM_UNSUPERVISED_AGE_YEARS}. Such an account
 *   exists only under supervision (ADR 0041); sign-up creates it awaiting a
 *   guardian.
 * - `teen`: old enough for an account of their own, not yet an adult. Apps
 *   apply their protective defaults.
 * - `adult`: at least {@link ADULT_AGE_YEARS}.
 *
 * An account with no date of birth has NO band (`undefined`), which is distinct
 * from every value here: "unknown" is never read as "adult" or as "minor".
 */
export const AGE_BANDS = ['under13', 'teen', 'adult'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * The earliest calendar year a date of birth may name.
 *
 * Not a biological bound: it catches an obviously transposed year (`1027` for
 * `2027`) with a clear message instead of a 150-year-old account. No living
 * person's real date is refused by it. The server's schema and every picker
 * read this one value, so a picker cannot offer a date the API refuses.
 */
export const MIN_BIRTH_YEAR = 1900;

/** The wire format of a date of birth: `YYYY-MM-DD`, nothing looser. */
export const DATE_OF_BIRTH_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a `YYYY-MM-DD` string names a day that exists on the Gregorian
 * calendar. The pattern only constrains digit count and would pass `2024-02-30`.
 */
export function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

/** Whether a `YYYY-MM-DD` string is not before {@link MIN_BIRTH_YEAR}. */
export function isBirthYearInRange(value: string): boolean {
  return Number(value.slice(0, 4)) >= MIN_BIRTH_YEAR;
}

/**
 * Whether a `YYYY-MM-DD` string is today (UTC) or earlier. Two zero-padded ISO
 * dates of equal length sort exactly as their dates do.
 */
export function isNotAfterToday(value: string, today: Date = new Date()): boolean {
  return value <= today.toISOString().slice(0, 10);
}

/**
 * What each date-of-birth rule says when it fails. The server's schema and the
 * client's check word a refusal identically because both read these.
 */
export const DATE_OF_BIRTH_MESSAGES = {
  format: 'dateOfBirth must be an ISO 8601 calendar date (YYYY-MM-DD)',
  calendar: 'dateOfBirth is not a real calendar date',
  tooEarly: `dateOfBirth must not be before ${MIN_BIRTH_YEAR}`,
  future: 'dateOfBirth must not be in the future',
} as const;

/** Below this age an account exists only under supervision. */
export const MINIMUM_UNSUPERVISED_AGE_YEARS = 13;

/** From this age an account is an adult's. */
export const ADULT_AGE_YEARS = 18;

/**
 * Whole years between an ISO calendar date (`YYYY-MM-DD`) and `today`, both
 * read in UTC.
 *
 * UTC because a date of birth has no time of day and no zone of its own, so
 * there is no authoritative zone to evaluate it in; UTC is the one every server
 * and every client agrees on without configuration. The effect is a band that
 * can change up to a day before or after the person's own local midnight.
 *
 * A birthday on 29 February counts on 1 March in a year that has none, which is
 * what `Date.UTC` yields for the 29th of a 28-day February.
 */
export function ageInYears(dateOfBirth: string, today: Date = new Date()): number {
  const [year, month, day] = dateOfBirth.split('-').map(Number);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let age = today.getUTCFullYear() - year;
  if (Date.UTC(year + age, month - 1, day) > todayUtc) age -= 1;
  return age;
}

/** The band of a validated ISO calendar date of birth. */
export function ageBandOf(dateOfBirth: string, today: Date = new Date()): AgeBand {
  const age = ageInYears(dateOfBirth, today);
  if (age < MINIMUM_UNSUPERVISED_AGE_YEARS) return 'under13';
  return age < ADULT_AGE_YEARS ? 'teen' : 'adult';
}

/**
 * Whether a person may move their own date of birth from one band to another.
 *
 * A first date (no band yet) is always theirs to give. After that the band may
 * stay or get YOUNGER, never older: growing older on paper is how a protection
 * would be removed, and that takes a reviewed correction, not a profile edit.
 */
export function isSelfServiceBandChange(from: AgeBand | undefined, to: AgeBand): boolean {
  if (from === undefined) return true;
  return AGE_BANDS.indexOf(to) <= AGE_BANDS.indexOf(from);
}

/**
 * Why a profile edit to the date of birth was refused: the error's `code`,
 * which a client maps to its own copy.
 *
 * - `locked`: the date is set and this edit would remove it or move the
 *   account to an older band.
 * - `supervisionRequired`: the date would put an existing account below the
 *   minimum unsupervised age; that account enrols through supervision.
 */
export const DATE_OF_BIRTH_REFUSALS = {
  locked: 'DATE_OF_BIRTH_LOCKED',
  supervisionRequired: 'DATE_OF_BIRTH_SUPERVISION_REQUIRED',
} as const;
export type DateOfBirthRefusal =
  (typeof DATE_OF_BIRTH_REFUSALS)[keyof typeof DATE_OF_BIRTH_REFUSALS];
