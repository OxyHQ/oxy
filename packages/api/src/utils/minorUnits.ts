/**
 * Exact conversion between the ledger's decimal amounts and the integer minor
 * units a payment processor deals in.
 *
 * ## Every operation here is a DECIMAL-POINT SHIFT, not arithmetic
 *
 * Converting `'12.3456'` to cents does not need multiplication: it needs the
 * digits re-cut at a different place. So every function below slices the digit
 * string and only ever converts to a JS `number` at the very end, guarded by
 * `Number.isSafeInteger`. Nothing here evaluates `Number('0.07') * 100`, which
 * is `7.000000000000001` — a cent that appears or disappears depending on which
 * side of the boundary rounded it.
 *
 * `BigInt` would express the same thing more directly and is deliberately not
 * used: this package compiles at `target: es6`, where a `bigint` literal and the
 * `**` operator over `bigint` are both compile errors, and raising the target
 * for one utility is a package-wide change with its own consequences.
 *
 * ## Two directions, two different rules, deliberately
 *
 * Going TO minor units is where money leaves this system, and it happens in two
 * situations that must not share a rule:
 *
 *  - {@link exactDecimalToMinorUnits} REFUSES an amount that is not exactly
 *    representable. It is for a charge a customer asked for — a $20.005 top-up
 *    has no correct rounding, and silently charging $20.01 or $20.00 is a
 *    discrepancy the customer will find before we do.
 *  - {@link roundExactDecimalToMinorUnits} rounds HALF-UP, and is only for the
 *    invoice boundary, where the exact subtotal genuinely carries sub-cent
 *    precision by design and the remainder is booked as an `invoice_rounding`
 *    ledger entry rather than discarded.
 *
 * A single function doing both would make the invoice rule available to the
 * checkout path, which is the direction that costs somebody money.
 *
 * ## The exponent is data, not knowledge
 *
 * USD is 2, JPY is 0, BHD is 3, and this database has no currency table. The
 * exponent is therefore passed in and STORED on any record that used it
 * (`billing_invoices.minor_unit_exponent`), so an invoice stays reproducible
 * even if this map later changes. {@link minorUnitExponentFor} is a convenience
 * for the currencies this platform actually transacts in, and it FAILS LOUDLY on
 * anything else rather than assuming two — a wrong assumption of 2 for JPY is a
 * charge a hundred times too small.
 */

import { INFERENCE_MONEY_SCALE } from '@oxyhq/contracts';

/** The scale every exact amount is carried at. */
const SCALE = INFERENCE_MONEY_SCALE;

/** The widest minor-unit exponent any currency uses. BHD and KWD are 3. */
const MAX_MINOR_UNIT_EXPONENT = 4;

/**
 * Minor-unit exponents for the currencies this platform transacts in.
 *
 * A short, explicit list rather than a full ISO 4217 table: the platform sells
 * in one currency today, and a table nobody maintains is worse than a map that
 * refuses what it does not know. Adding a currency is a deliberate edit here
 * plus a price version denominated in it.
 */
export const CURRENCY_MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

/** Raised when a currency's minor-unit exponent is not known. */
export class UnknownCurrencyExponentError extends Error {
  constructor(readonly currency: string) {
    super(
      `no minor-unit exponent is registered for ${currency}; add it to ` +
        'CURRENCY_MINOR_UNIT_EXPONENTS before transacting in it'
    );
    this.name = 'UnknownCurrencyExponentError';
  }
}

/**
 * The minor-unit exponent for a currency code.
 *
 * Throws rather than defaulting. A default of 2 is right for most currencies and
 * catastrophically wrong for the ones it is not, and the failure is silent: a
 * JPY charge would be a hundredth of its intended size and every total would
 * still add up.
 */
export function minorUnitExponentFor(currency: string): number {
  const exponent = CURRENCY_MINOR_UNIT_EXPONENTS[currency.toUpperCase()];
  if (exponent === undefined) {
    throw new UnknownCurrencyExponentError(currency);
  }
  return exponent;
}

/** An exact decimal cut into its integer digits and its {@link SCALE} fraction digits. */
function splitExact(amount: string): { integerDigits: string; fractionDigits: string } {
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(amount);
  if (!match) {
    throw new Error(`not an exact non-negative decimal at scale ${SCALE}: ${amount}`);
  }
  const [, integerDigits, fractionDigits = ''] = match;
  return { integerDigits, fractionDigits: fractionDigits.padEnd(SCALE, '0') };
}

function assertExponent(exponent: number): void {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > MAX_MINOR_UNIT_EXPONENT) {
    throw new Error(`minor-unit exponent out of range: ${exponent}`);
  }
}

/**
 * An integer count of minor units as an exact decimal amount.
 *
 * `1234` at exponent 2 is `'12.34'`; `1234` at exponent 0 is `'1234'`. Both
 * satisfy `exactDecimalSchema`, which admits an integer with no fractional part.
 */
export function minorUnitsToExactDecimal(minorUnits: number, exponent: number): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new Error(`minor units must be a non-negative safe integer: ${minorUnits}`);
  }
  assertExponent(exponent);
  if (exponent === 0) {
    return String(minorUnits);
  }
  const digits = String(minorUnits).padStart(exponent + 1, '0');
  const integerPart = digits.slice(0, digits.length - exponent);
  const fractionPart = digits.slice(digits.length - exponent);
  return `${integerPart}.${fractionPart}`;
}

/**
 * An exact amount as integer minor units, or `null` when it does not divide
 * evenly.
 *
 * `null` is the whole point: see the module header. A caller that receives it
 * must refuse, not round. It is also returned for an amount too large to be a
 * safe integer count of minor units, because a number that cannot be represented
 * exactly must not be charged.
 */
export function exactDecimalToMinorUnits(amount: string, exponent: number): number | null {
  assertExponent(exponent);
  const { integerDigits, fractionDigits } = splitExact(amount);
  const kept = fractionDigits.slice(0, exponent);
  const dropped = fractionDigits.slice(exponent);
  if (/[1-9]/.test(dropped)) {
    return null;
  }
  const minorUnits = Number(integerDigits + kept);
  return Number.isSafeInteger(minorUnits) ? minorUnits : null;
}

/**
 * An exact amount rounded HALF-UP to whole minor units, and the exact remainder
 * that rounding moved.
 *
 * Both halves are returned because the remainder is not waste: it is booked as
 * an `invoice_rounding` ledger entry, so the books stay closed. A function that
 * returned only the rounded figure would make discarding it the easy path.
 *
 * `remainder` is `|subtotal − rounded|` and is always non-negative; which way it
 * went is carried by `direction`, never by a sign. `exactDecimalSchema` admits
 * no negative amount by design — a stray sign is how a reversal becomes a second
 * charge — so the direction has to be a separate field rather than the
 * amount's.
 *
 * Half-up is decided by ONE digit: the dropped fraction is `0.d₁d₂…`, so it is
 * at least a half exactly when `d₁ >= 5`. No comparison of the whole tail is
 * needed, and doing one would be the arithmetic this module avoids.
 */
export function roundExactDecimalToMinorUnits(
  amount: string,
  exponent: number
): {
  minorUnits: number;
  roundedAmount: string;
  remainder: string;
  direction: 'rounded_down' | 'rounded_up' | 'exact';
} {
  assertExponent(exponent);
  const { integerDigits, fractionDigits } = splitExact(amount);
  const kept = fractionDigits.slice(0, exponent);
  const dropped = fractionDigits.slice(exponent);

  const flooredUnits = Number(integerDigits + kept);
  if (!Number.isSafeInteger(flooredUnits)) {
    throw new Error(`amount ${amount} exceeds the safe integer range in minor units`);
  }

  if (!/[1-9]/.test(dropped)) {
    return {
      minorUnits: flooredUnits,
      roundedAmount: minorUnitsToExactDecimal(flooredUnits, exponent),
      remainder: '0',
      direction: 'exact',
    };
  }

  const roundsUp = dropped.charCodeAt(0) >= '5'.charCodeAt(0);
  const minorUnits = roundsUp ? flooredUnits + 1 : flooredUnits;

  // The remainder lives entirely below the minor unit, so it is the dropped
  // digits placed back where they came from: `exponent` zeros, then the tail.
  // Rounding UP overshot by the COMPLEMENT of that tail within one minor unit.
  const tail = roundsUp ? complementDigits(dropped) : dropped;

  return {
    minorUnits,
    roundedAmount: minorUnitsToExactDecimal(minorUnits, exponent),
    remainder: `0.${'0'.repeat(exponent)}${tail}`,
    direction: roundsUp ? 'rounded_up' : 'rounded_down',
  };
}

/**
 * `10^n − d`, for an `n`-digit string `d`, as an `n`-digit string.
 *
 * `n` is at most {@link SCALE} = 12, so `Number(d)` is always a safe integer and
 * the subtraction is exact. Called only when `d` is non-zero, which is what
 * keeps the result inside `n` digits.
 */
function complementDigits(digits: string): string {
  const magnitude = Number(`1${'0'.repeat(digits.length)}`);
  return String(magnitude - Number(digits)).padStart(digits.length, '0');
}

/**
 * Two exact amounts, compared as NUMBERS rather than as text.
 *
 * `'3.0'` and `'3.000000000000'` are one amount written two ways. A string
 * comparison would report them different, which on a reconciliation report means
 * a finding on every single row — and a report full of false findings is one
 * nobody reads, which is the same outcome as no report at all.
 */
export function sameExactAmount(left: string, right: string): boolean {
  const a = splitExact(left);
  const b = splitExact(right);
  return (
    a.integerDigits.replace(/^0+(?=\d)/, '') === b.integerDigits.replace(/^0+(?=\d)/, '') &&
    a.fractionDigits === b.fractionDigits
  );
}
