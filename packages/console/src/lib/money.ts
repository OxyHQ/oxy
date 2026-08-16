/**
 * Money, as the ledger hands it over: an exact decimal STRING.
 *
 * ## Why there is no `Number()` in this file
 *
 * `@oxyhq/contracts`' `exactDecimalSchema` carries every amount as a
 * non-negative decimal string with up to 12 fractional digits and no exponent,
 * because a JS `number` cannot represent `0.1 + 0.2` and an inference ledger
 * adds millions of tiny amounts. The moment a Console component writes
 * `Number(amount).toFixed(2)` the exactness the whole ledger exists to protect
 * is gone — and it is gone SILENTLY, because the wrong figure still looks like
 * money.
 *
 * So every function here works on the digits as text: grouping is string
 * splicing, comparison is a padded lexicographic compare, and "is this zero" is
 * a regex. None of them can lose a digit, and none of them can round.
 *
 * `__tests__/money.test.ts` holds the property that matters — a 12-digit
 * fraction that a float would mangle survives a round trip through the
 * formatter unchanged.
 *
 * ## What this file deliberately does NOT offer
 *
 * There is no `add`, no `sum` and no `toPercentOfTotal`. Adding two amounts is
 * the server's job: `/spend` already returns per-currency totals, and totalling
 * two currencies is arithmetic on incomparable quantities. A Console helper that
 * summed money would be used, and the first thing it would be used for is a
 * figure the ledger never produced.
 */

/** Digits of an exact decimal, split at the point. */
interface DecimalParts {
  readonly integer: string;
  readonly fraction: string;
}

const EXACT_DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * Split an exact decimal string, or `undefined` if it is not one.
 *
 * Refusing rather than coercing: an unparseable amount is a contract violation,
 * and rendering `NaN` where a customer expects a charge is worse than rendering
 * the raw string the server actually sent.
 *
 * The shape is TESTED first and sliced second, rather than read out of capture
 * groups: a group inside an optional section is `string | undefined` in fact and
 * `string` to the compiler, so the missing-fraction case would be a `?? ''` that
 * looks redundant and is not.
 */
function splitDecimal(amount: string): DecimalParts | undefined {
  const trimmed = amount.trim();
  if (!EXACT_DECIMAL.test(trimmed)) {
    return undefined;
  }
  const point = trimmed.indexOf('.');
  return point === -1
    ? { integer: trimmed, fraction: '' }
    : { integer: trimmed.slice(0, point), fraction: trimmed.slice(point + 1) };
}

/** Group an integer digit string in threes, from the right. */
function groupIntegerDigits(digits: string): string {
  const stripped = digits.replace(/^0+(?=\d)/, '');
  let grouped = '';
  for (let index = 0; index < stripped.length; index += 1) {
    const fromRight = stripped.length - index;
    grouped += stripped[index];
    if (fromRight > 1 && fromRight % 3 === 1) {
      grouped += ',';
    }
  }
  return grouped;
}

/**
 * The fraction as it should be shown: trailing zeros dropped, but never below
 * two digits.
 *
 * Dropping trailing zeros is the one edit that cannot change the value —
 * `3.000000000000` and `3.00` are the same amount — while keeping the
 * significant tail means a per-token price of `0.000003000000` renders as
 * `0.000003` rather than as a `0.00` that reads like nothing was charged.
 */
function displayFraction(fraction: string): string {
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length >= 2 ? trimmed : trimmed.padEnd(2, '0');
}

/**
 * The number part of an amount, grouped for reading. No currency.
 *
 * An amount this cannot parse is returned VERBATIM. That is deliberate: the
 * screen then shows what the server said, which is diagnosable, instead of a
 * plausible-looking substitute.
 */
export function formatAmount(amount: string): string {
  const parts = splitDecimal(amount);
  if (parts === undefined) {
    return amount;
  }
  return `${groupIntegerDigits(parts.integer)}.${displayFraction(parts.fraction)}`;
}

/** An amount with its currency code, which is the only form a customer sees. */
export function formatMoney(amount: string, currency: string): string {
  return `${formatAmount(amount)} ${currency}`;
}

/** True when an amount is exactly zero, however many zeros it was written with. */
export function isZeroAmount(amount: string): boolean {
  const parts = splitDecimal(amount);
  if (parts === undefined) {
    return false;
  }
  return /^0+$/.test(parts.integer) && /^0*$/.test(parts.fraction);
}

/**
 * Order two exact decimals: `-1`, `0` or `1`.
 *
 * Used to sort a spend table by size. A plain string compare would put `9.00`
 * above `10.00` and a numeric compare would reintroduce the float, so this pads
 * both sides to a common shape first and compares the digits.
 */
export function compareExactDecimals(left: string, right: string): number {
  const a = splitDecimal(left);
  const b = splitDecimal(right);
  if (a === undefined || b === undefined) {
    // Neither is orderable as a number; fall back to a stable text order rather
    // than claiming an equality that would silently reorder a table.
    return left === right ? 0 : left < right ? -1 : 1;
  }

  const aInteger = a.integer.replace(/^0+(?=\d)/, '');
  const bInteger = b.integer.replace(/^0+(?=\d)/, '');
  if (aInteger.length !== bInteger.length) {
    return aInteger.length < bInteger.length ? -1 : 1;
  }
  if (aInteger !== bInteger) {
    return aInteger < bInteger ? -1 : 1;
  }

  const width = Math.max(a.fraction.length, b.fraction.length);
  const aFraction = a.fraction.padEnd(width, '0');
  const bFraction = b.fraction.padEnd(width, '0');
  if (aFraction === bFraction) {
    return 0;
  }
  return aFraction < bFraction ? -1 : 1;
}

/**
 * Basis points of a budget consumed, as a percentage.
 *
 * A count, not money: `utilizationBps` is a server-computed integer bounded at
 * 10000, so ordinary arithmetic is exact here and the no-float rule above does
 * not apply. It is stated rather than assumed, because the two kinds of number
 * sit side by side on the budgets screen.
 */
export function formatBasisPoints(bps: number): string {
  if (bps % 100 === 0) {
    return `${bps / 100}%`;
  }
  return `${(bps / 100).toFixed(1)}%`;
}

/** Whole counts — requests, tokens, images. Never an amount of money. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
