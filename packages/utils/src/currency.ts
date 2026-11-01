/**
 * Money: how an amount in a currency becomes text, how it is stored as an
 * integer, and how it moves between currencies at a rate the caller supplies.
 *
 * ## Why this is shared, when the copies disagree
 *
 * Six apps format money and no two did it the same way. Homiio places the
 * symbol by locale through `Intl` and falls back to `1.234 FAIR`; Mercaria
 * prefixes its own symbol table (`€148,00` in German, where `Intl` writes
 * `148,00 €`); Inbox falls back code-FIRST (`USD 12.00`); Moovo stores FAIR at
 * two decimals while Mercaria stores it at eight. Unlike compact numbers (see
 * the README), these were not left to drift: the product owner ruled on each
 * split, and the rulings are what this module encodes — so clause 3 of the
 * admission rule holds by decision, the way `calendarDaysBetween` holds because
 * one of its two roundings was a bug.
 *
 * - **Storage precision is not display precision.** FAIR (FairCoin, not ISO
 *   4217, symbol `⊜`) is stored at {@link FAIR_DECIMALS} = 8 decimals
 *   everywhere, and DISPLAYED at 2. ISO currencies display with the digits
 *   `Intl` gives them (EUR/USD 2, JPY 0) and store at their ISO 4217 exponent.
 *   Nothing here ever renders `12.34567890 FAIR`.
 * - **The locale decides the shape; the amount's own currency decides the
 *   money.** `1.234,56 €` in `es`, `€1,234.56` in `en`. No function reads the
 *   locale to choose a currency.
 * - **A code `Intl` cannot format** (FAIR, anything that is not three letters)
 *   renders AMOUNT then CODE: the number formatted for the locale, a no-break
 *   space, the code — `1.234,56 FAIR`. No symbol is invented for it.
 * - **Formatting never throws.** A malformed locale or code, a `NaN`, an
 *   engine without `narrowSymbol` — each degrades to readable text, because
 *   every caller is a render path.
 *
 * Out of scope, and staying in the apps: fetching exchange rates (they are
 * injected — {@link convertAmount}), the user's preferred currency, currency
 * pickers, flag lists and glyph components.
 */

/** FairCoin's currency code. Not ISO 4217: four letters, so `Intl` rejects it. */
export const FAIR_CODE = 'FAIR';

/** FairCoin's glyph, for the apps' own symbol components. {@link formatMoney} writes the code. */
export const FAIR_SYMBOL = '⊜';

/**
 * FairCoin's STORAGE precision: one FAIR is `10 ** 8` minor units. Display
 * uses {@link currencyDisplayDigits} (2), never this.
 */
export const FAIR_DECIMALS = 8;

/** FairCoin's proper name, used where a currency is spelled out. */
const FAIR_NAME = 'FairCoin';

/** Fraction digits FAIR, and any code `Intl` cannot format, display with. */
const FALLBACK_DISPLAY_DIGITS = 2;

/** The largest fraction-digit count every `Intl` engine accepts (ES2020 caps at 20). */
const MAX_FRACTION_DIGITS = 20;

/** Between an amount and a code `Intl` could not place: no-break, so they never wrap apart. */
const CODE_SEPARATOR = ' ';

/** Between the two ends of a range: an en dash, unspaced, as Homiio shipped it. */
const RANGE_SEPARATOR = '–';

/** ISO 4217 alphabetic codes are exactly three letters. */
const ISO_SHAPE = /^[A-Z]{3}$/;

/**
 * ISO 4217 minor-unit exponents that are not 2 (every other active code is 2).
 *
 * A static table and not `Intl`, deliberately: what `Intl` reports is CLDR's
 * DISPLAY precision, which differs from the ISO exponent for a dozen codes
 * (`IQD`, `RSD`, `ALL`, `LAK`… display 0 but are 2 or 3 in ISO) and has changed
 * between ICU releases. A stored integer must mean the same amount on the
 * server's Node and the phone's Hermes, so storage precision cannot depend on
 * which engine read it.
 */
const ISO_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/** How the currency is written. Maps to `Intl.NumberFormat`'s `currencyDisplay`. */
export type CurrencyDisplay = 'symbol' | 'narrowSymbol' | 'code' | 'name';

/** Options accepted by {@link formatMoney} and {@link formatMoneyRange}. */
export interface FormatMoneyOptions {
  /** Defaults to the currency's display digits ({@link currencyDisplayDigits}). */
  minimumFractionDigits?: number;
  /** Defaults to the currency's display digits, and is never below the minimum. */
  maximumFractionDigits?: number;
  /**
   * `symbol` (default) for visible text; `name` for accessibility labels
   * ("1,700.00 euros"). A code `Intl` cannot format is always written as its
   * code, except that `name` spells FAIR as "FairCoin".
   */
  currencyDisplay?: CurrencyDisplay;
}

/** Exchange rates as every app already receives them: units of each currency per ONE `base`. */
export interface ExchangeRates {
  /** The currency every entry in `rates` is quoted against. */
  base: string;
  /** Code → units of that currency per 1 `base`. `{ base: 'FAIR', rates: { EUR: 0.45 } }` is 1 FAIR = 0.45 EUR. */
  rates: Readonly<Record<string, number>>;
}

/** How {@link toMinorUnits} breaks a tie: away from zero (default), or to the even neighbour. */
export type MinorUnitRounding = 'halfExpand' | 'halfEven';

/** Trimmed and upper-cased: codes arrive from query strings and old rows as `' eur '`. */
function normalizeCode(code: string): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

/**
 * `Intl.NumberFormat` construction is an ICU lookup and these render inside
 * lists, so formatters are memoized. A pure cache — same key, same formatter —
 * bounded by clearing it rather than by an eviction policy, since the working
 * set (a few locales × a few currencies) is tiny.
 */
const formatterCache = new Map<string, Intl.NumberFormat | null>();
const FORMATTER_CACHE_LIMIT = 256;

function cachedFormatter(
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat | null {
  const key = `${locale ?? ''}|${options.style ?? ''}|${options.currency ?? ''}|${options.currencyDisplay ?? ''}|${options.minimumFractionDigits}|${options.maximumFractionDigits}`;
  const cached = formatterCache.get(key);
  if (cached !== undefined) return cached;
  let formatter: Intl.NumberFormat | null;
  try {
    formatter = new Intl.NumberFormat(locale, options);
  } catch {
    formatter = null;
  }
  if (formatterCache.size >= FORMATTER_CACHE_LIMIT) formatterCache.clear();
  formatterCache.set(key, formatter);
  return formatter;
}

/** Format with `locale`, then the runtime default (a malformed tag throws), else `null`. */
function formatWith(
  value: number,
  locale: string,
  options: Intl.NumberFormatOptions,
): string | null {
  const formatter = cachedFormatter(locale, options) ?? cachedFormatter(undefined, options);
  return formatter ? formatter.format(value) : null;
}

/**
 * Whether `Intl` will format `code` as a currency on this engine.
 *
 * Every engine accepts any well-formed three-letter code (it does not check the
 * ISO list), so this is a SHAPE test confirmed by a real construction — and,
 * because of that, the same answer on Node, browsers and Hermes. It is what
 * decides {@link formatMoney}'s path, so the same code takes the same path
 * everywhere.
 */
function intlFormatsCurrency(code: string): boolean {
  return (
    ISO_SHAPE.test(code) && cachedFormatter('en', { style: 'currency', currency: code }) !== null
  );
}

let supportedCurrencies: ReadonlySet<string> | null | undefined;

/** `Intl.supportedValuesOf('currency')`, where the engine has it (ES2022; not every Hermes). */
function engineCurrencyList(): ReadonlySet<string> | null {
  if (supportedCurrencies !== undefined) return supportedCurrencies;
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] };
  try {
    supportedCurrencies =
      typeof intl.supportedValuesOf === 'function'
        ? new Set(intl.supportedValuesOf('currency'))
        : null;
  } catch {
    supportedCurrencies = null;
  }
  return supportedCurrencies;
}

/**
 * Whether `code` is an ISO 4217 currency the engine knows. Case-insensitive,
 * whitespace-tolerant. `FAIR` is not; `EUR`, `eur`, `JPY` are.
 *
 * Backed by `Intl.supportedValuesOf('currency')` where the engine has it, so
 * `ZZZ` is rejected; on an engine without it (older Hermes) the answer degrades
 * to "well-formed and accepted by `Intl.NumberFormat`", which `ZZZ` passes. Use
 * it to VALIDATE input; {@link formatMoney} does not depend on it.
 */
export function isIsoCurrencyCode(code: string): boolean {
  const normalized = normalizeCode(code);
  if (!intlFormatsCurrency(normalized)) return false;
  const list = engineCurrencyList();
  return list === null || list.has(normalized);
}

/**
 * How many fraction digits `code` DISPLAYS with by default: `Intl`'s own answer
 * for a currency it formats (EUR 2, JPY 0, KWD 3), and 2 for FAIR and any code
 * it cannot format.
 */
export function currencyDisplayDigits(code: string): number {
  const normalized = normalizeCode(code);
  if (normalized === FAIR_CODE || !intlFormatsCurrency(normalized)) {
    return FALLBACK_DISPLAY_DIGITS;
  }
  const formatter = cachedFormatter('en', { style: 'currency', currency: normalized });
  return formatter?.resolvedOptions().maximumFractionDigits ?? FALLBACK_DISPLAY_DIGITS;
}

/**
 * How many decimals `code` is STORED with — the exponent {@link toMinorUnits}
 * and {@link fromMinorUnits} scale by: 8 for FAIR, the ISO 4217 exponent for a
 * three-letter code (JPY 0, EUR 2, KWD 3), and `null` for anything else.
 *
 * `null` rather than a guess: an amount in minor units read at the wrong
 * precision is wrong by a factor of 100, and Mercaria's rule for exactly that
 * case is that an unknown divisor is never assumed.
 */
export function currencyStorageDigits(code: string): number | null {
  const normalized = normalizeCode(code);
  if (normalized === FAIR_CODE) return FAIR_DECIMALS;
  if (!ISO_SHAPE.test(normalized)) return null;
  return ISO_EXPONENTS[normalized] ?? 2;
}

/** A caller's digit option, if it is one `Intl` will take; otherwise `undefined`. */
function digitOption(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_FRACTION_DIGITS, Math.max(0, Math.floor(value)));
}

/**
 * Format `amount` (MAJOR units — `12.5`, not `1250`) of `currency` for `locale`.
 *
 * ```ts
 * formatMoney(1234.56, 'EUR', 'es-ES'); // '1234,56 €'  (es does not group 4 digits)
 * formatMoney(1234.56, 'EUR', 'en-US'); // '€1,234.56'
 * formatMoney(1234.5, 'JPY', 'ja-JP');  // '￥1,235'
 * formatMoney(1234.56, 'FAIR', 'de-DE'); // '1.234,56 FAIR'
 * ```
 *
 * Digits default to the currency's display digits, so FAIR shows 2 whatever
 * it is stored with; pass `minimumFractionDigits: 0` to drop trailing zeros
 * (`€1,700` for a whole rent). A non-finite amount renders as zero in the same
 * currency rather than `NaN`; an amount that rounds to zero never renders as
 * `-0.00`. A malformed locale uses the runtime default. Never throws.
 */
export function formatMoney(
  amount: number,
  currency: string,
  locale: string,
  options: FormatMoneyOptions = {},
): string {
  const code = normalizeCode(currency);
  const defaultDigits = currencyDisplayDigits(code);
  const requestedMax = digitOption(options.maximumFractionDigits);
  const minimumFractionDigits =
    digitOption(options.minimumFractionDigits) ??
    Math.min(defaultDigits, requestedMax ?? defaultDigits);
  const maximumFractionDigits = Math.max(minimumFractionDigits, requestedMax ?? defaultDigits);

  const finite = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  // Below half the last shown digit the amount displays as zero, and a signed
  // zero would read "-€0.00".
  const value = Math.abs(finite) < 0.5 * 10 ** -maximumFractionDigits ? 0 : finite;
  const display = options.currencyDisplay ?? 'symbol';

  if (intlFormatsCurrency(code)) {
    const currencyOptions: Intl.NumberFormatOptions = {
      style: 'currency',
      currency: code,
      currencyDisplay: display,
      minimumFractionDigits,
      maximumFractionDigits,
    };
    const text =
      formatWith(value, locale, currencyOptions) ??
      // `narrowSymbol` is ES2020 and an older engine throws on it.
      formatWith(value, locale, { ...currencyOptions, currencyDisplay: 'symbol' });
    if (text !== null) return text;
  }

  const number =
    formatWith(value, locale, { minimumFractionDigits, maximumFractionDigits }) ??
    value.toFixed(maximumFractionDigits);
  if (!code) return number;
  const label = display === 'name' && code === FAIR_CODE ? FAIR_NAME : code;
  return `${number}${CODE_SEPARATOR}${label}`;
}

/**
 * Format a range in one currency: `€500–€1,200`.
 *
 * Either end may be absent (`null`, `undefined`, non-finite) so an open filter
 * reuses it — one end returns just that end, leaving "from"/"up to" to the
 * caller's i18n; neither returns `''`. Two ends that format identically
 * collapse to one rather than reading `€500–€500`.
 */
export function formatMoneyRange(
  min: number | null | undefined,
  max: number | null | undefined,
  currency: string,
  locale: string,
  options: FormatMoneyOptions = {},
): string {
  const low =
    typeof min === 'number' && Number.isFinite(min)
      ? formatMoney(min, currency, locale, options)
      : '';
  const high =
    typeof max === 'number' && Number.isFinite(max)
      ? formatMoney(max, currency, locale, options)
      : '';
  if (low && high && low !== high) return `${low}${RANGE_SEPARATOR}${high}`;
  return low || high;
}

/**
 * The currency's name in `locale`: `euro` in `es`, `Euro` in `de`, `FairCoin`
 * for FAIR. Falls back to the code where `Intl.DisplayNames` is missing (older
 * Hermes) or the locale is malformed, and to `''` for an empty code.
 */
export function currencyName(code: string, locale: string): string {
  const normalized = normalizeCode(code);
  if (normalized === FAIR_CODE) return FAIR_NAME;
  if (!ISO_SHAPE.test(normalized)) return normalized;
  const DisplayNames = (
    Intl as {
      DisplayNames?: new (
        locales: string | undefined,
        options: { type: 'currency' },
      ) => { of(code: string): string | undefined };
    }
  ).DisplayNames;
  if (typeof DisplayNames !== 'function') return normalized;
  for (const tag of [locale, undefined]) {
    try {
      return new DisplayNames(tag, { type: 'currency' }).of(normalized) ?? normalized;
    } catch {
      // A malformed tag: try the runtime default, then give up on a name.
    }
  }
  return normalized;
}

/**
 * Move the decimal point `places` to the right on the value's DECIMAL text, not
 * by multiplying: `1.005 * 100` is `100.49999999999999`, and the tie the user
 * typed would round down. `Number('1.005e2')` is exactly `100.5`.
 */
function shiftDecimal(value: number, places: number): number {
  const [mantissa, exponent] = String(value).split('e');
  return Number(`${mantissa}e${Number(exponent ?? 0) + places}`);
}

function roundHalf(value: number, rounding: MinorUnitRounding): number {
  const magnitude = Math.abs(value);
  const floor = Math.floor(magnitude);
  const fraction = magnitude - floor;
  let rounded: number;
  if (fraction > 0.5) rounded = floor + 1;
  else if (fraction < 0.5) rounded = floor;
  else rounded = rounding === 'halfEven' && floor % 2 === 0 ? floor : floor + 1;
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

/**
 * MAJOR units → integer MINOR units at the currency's storage precision:
 * `toMinorUnits(12.5, 'EUR')` is `1250`, `toMinorUnits(1, 'FAIR')` is
 * `100_000_000`, `toMinorUnits(100, 'JPY')` is `100`.
 *
 * Returns a `number`, which is what `Money.amount` is in every app; a ledger
 * that stores `bigint` takes `BigInt(result)`. Ties round away from zero, or to
 * even with `{ rounding: 'halfEven' }` (Mercaria's FX convention). Returns
 * `null` — never a clamped or guessed figure — for a non-finite amount, a code
 * with no known storage precision, or a result beyond `Number.MAX_SAFE_INTEGER`
 * (about 90 million FAIR), where integers stop being exact.
 */
export function toMinorUnits(
  amount: number,
  currency: string,
  options: { rounding?: MinorUnitRounding } = {},
): number | null {
  const digits = currencyStorageDigits(currency);
  if (digits === null || typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const minor = roundHalf(shiftDecimal(amount, digits), options.rounding ?? 'halfExpand');
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Integer MINOR units → MAJOR units: `fromMinorUnits(1250, 'EUR')` is `12.5`,
 * `fromMinorUnits(100_000_000, 'FAIR')` is `1`. Accepts a `bigint` from a
 * ledger; the result is a `number` for display and major-unit arithmetic.
 *
 * Returns `null` for a code with no known storage precision and for a `number`
 * that is not a safe integer — a fractional "minor unit" is a value already
 * read at the wrong scale.
 */
export function fromMinorUnits(minor: number | bigint, currency: string): number | null {
  const digits = currencyStorageDigits(currency);
  if (digits === null) return null;
  if (typeof minor === 'bigint') {
    // Through the decimal text, so the one rounding is `Number`'s own: adding
    // a whole part and a fraction would round twice (1.2345678900000001).
    const sign = minor < BigInt(0) ? '-' : '';
    const digitsText = (sign ? -minor : minor).toString().padStart(digits + 1, '0');
    const whole = digitsText.slice(0, digitsText.length - digits);
    const fraction = digitsText.slice(digitsText.length - digits);
    return Number(`${sign}${whole}${fraction ? `.${fraction}` : ''}`);
  }
  if (!Number.isSafeInteger(minor)) return null;
  return shiftDecimal(minor, -digits);
}

/** Units of `code` per one `rates.base`; `null` when missing or unusable. */
function ratePerBase(code: string, rates: ExchangeRates): number | null {
  if (code === normalizeCode(rates.base)) return 1;
  const rate = rates.rates[code];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Convert a MAJOR-unit `amount` from one currency to another through `rates`,
 * which the caller fetched (and timestamped) — this never fetches.
 *
 * Any pair works whatever the base: both sides are read against `rates.base`,
 * so EUR → USD on a FAIR-based table is `amount / rate(EUR) * rate(USD)`. The
 * same currency returns `amount` untouched.
 *
 * The result is UNROUNDED: round once, where it is stored or shown
 * ({@link toMinorUnits}, {@link formatMoney}), so a cross conversion never
 * rounds twice. Returns `null` — never a fabricated rate of 1 — when either
 * side has no positive finite rate, `amount` is not finite, or the calculation
 * overflows. The last case can occur in an intermediate step even when the
 * mathematical result would fit in a number; it returns `null` rather than an
 * infinite amount that a formatter might display as zero.
 */
export function convertAmount(
  amount: number,
  from: string,
  to: string,
  rates: ExchangeRates,
): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const source = normalizeCode(from);
  const target = normalizeCode(to);
  if (source === target) return amount;
  const sourcePerBase = ratePerBase(source, rates);
  const targetPerBase = ratePerBase(target, rates);
  if (sourcePerBase === null || targetPerBase === null) return null;
  const result = (amount / sourcePerBase) * targetPerBase;
  return Number.isFinite(result) ? result : null;
}
