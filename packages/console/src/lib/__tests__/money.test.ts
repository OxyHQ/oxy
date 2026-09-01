import { describe, expect, it } from 'vitest';
import {
  compareExactDecimals,
  formatAmount,
  formatBasisPoints,
  formatCount,
  formatMoney,
  isUnitPriceAtMost,
  isZeroAmount,
} from '@/lib/money';

describe('formatAmount', () => {
  /**
   * The property the whole module exists for.
   *
   * `9007199254740993` is one above `Number.MAX_SAFE_INTEGER`, so a formatter
   * that went through `Number()` would render `9,007,199,254,740,992` and lose
   * the fractional tail entirely — a wrong figure that still looks like money.
   * If this assertion ever passes with a float implementation underneath it, the
   * test has stopped measuring anything.
   */
  it('preserves digits a JS number cannot represent', () => {
    expect(formatAmount('9007199254740993.000000000001')).toBe(
      '9,007,199,254,740,993.000000000001'
    );
  });

  it('groups the integer part in threes', () => {
    expect(formatAmount('0.00')).toBe('0.00');
    expect(formatAmount('7.5')).toBe('7.50');
    expect(formatAmount('999.00')).toBe('999.00');
    expect(formatAmount('1000.00')).toBe('1,000.00');
    expect(formatAmount('1234567.89')).toBe('1,234,567.89');
  });

  it('drops trailing zeros but never falls below two fractional digits', () => {
    // Dropping trailing zeros cannot change the value; padding to two keeps a
    // whole amount looking like money rather than like a count.
    expect(formatAmount('3.000000000000')).toBe('3.00');
    expect(formatAmount('3')).toBe('3.00');
    expect(formatAmount('0.003060000000')).toBe('0.00306');
    // A per-token price: rounding this to two places would render it as nothing
    // was charged.
    expect(formatAmount('0.000003000000')).toBe('0.000003');
  });

  it('strips leading zeros without eating the last one', () => {
    expect(formatAmount('0000.50')).toBe('0.50');
    expect(formatAmount('0')).toBe('0.00');
  });

  it('returns an unparseable amount verbatim rather than inventing one', () => {
    // A contract violation should be diagnosable on screen, not replaced with a
    // plausible substitute.
    expect(formatAmount('1e-6')).toBe('1e-6');
    expect(formatAmount('-5.00')).toBe('-5.00');
    expect(formatAmount('')).toBe('');
    expect(formatAmount('abc')).toBe('abc');
  });
});

describe('formatMoney', () => {
  it('always carries the currency code', () => {
    expect(formatMoney('12.5', 'USD')).toBe('12.50 USD');
    expect(formatMoney('12.5', 'EUR')).toBe('12.50 EUR');
  });
});

describe('isZeroAmount', () => {
  it('recognises every spelling of zero', () => {
    expect(isZeroAmount('0')).toBe(true);
    expect(isZeroAmount('0.00')).toBe(true);
    expect(isZeroAmount('0.000000000000')).toBe(true);
    expect(isZeroAmount('00.0')).toBe(true);
  });

  it('is false for anything non-zero, and for anything unparseable', () => {
    expect(isZeroAmount('0.000000000001')).toBe(false);
    expect(isZeroAmount('1')).toBe(false);
    expect(isZeroAmount('abc')).toBe(false);
  });
});

describe('compareExactDecimals', () => {
  it('orders by value, not by text', () => {
    // The case a plain string sort gets wrong.
    expect(compareExactDecimals('9.00', '10.00')).toBe(-1);
    expect(compareExactDecimals('10.00', '9.00')).toBe(1);
  });

  it('treats the same amount written two ways as equal', () => {
    expect(compareExactDecimals('3', '3.000000000000')).toBe(0);
    expect(compareExactDecimals('0.5', '0.50')).toBe(0);
    expect(compareExactDecimals('007', '7')).toBe(0);
  });

  it('compares fractions beyond float precision', () => {
    expect(compareExactDecimals('0.000000000001', '0.000000000002')).toBe(-1);
    expect(compareExactDecimals('1.000000000002', '1.000000000001')).toBe(1);
  });

  it('sorts a table descending without parsing', () => {
    const amounts = ['9.99', '100.00', '0.000001', '10.5'];
    const sorted = [...amounts].sort((left, right) => compareExactDecimals(right, left));
    expect(sorted).toEqual(['100.00', '10.5', '9.99', '0.000001']);
  });

  it('falls back to a stable text order for unparseable input', () => {
    expect(compareExactDecimals('abc', 'abc')).toBe(0);
    expect(compareExactDecimals('abc', 'abd')).toBe(-1);
  });
});

describe('isUnitPriceAtMost', () => {
  /**
   * The property this function exists for: the two sides are quoted per
   * DIFFERENT denominators, and the row whose raw `amount` is smaller is the more
   * expensive one. An implementation comparing `amount` alone answers both of
   * these backwards, and an implementation that divided to normalise would have
   * to round somewhere.
   */
  it('compares rates, not amounts', () => {
    const perThousand = { amount: '0.005000000000', per: 1_000 };
    const perMillion = { amount: '3.000000000000', per: 1_000_000 };
    const cap = { amount: '4.00', per: 1_000_000 };

    expect(isUnitPriceAtMost(perMillion, cap)).toBe(true);
    // 0.005 per 1,000 == 5.00 per 1,000,000, so it is OVER a 4.00 cap despite
    // the far smaller amount string.
    expect(isUnitPriceAtMost(perThousand, cap)).toBe(false);
  });

  it('is at-MOST, so an equal rate passes and a hair more does not', () => {
    const price = { amount: '3.000000000000', per: 1_000_000 };
    expect(isUnitPriceAtMost(price, { amount: '3.00', per: 1_000_000 })).toBe(true);
    expect(isUnitPriceAtMost(price, { amount: '2.999999999999', per: 1_000_000 })).toBe(false);
  });

  it('stays exact where a float would not', () => {
    // `0.1 + 0.2 !== 0.3` is the canonical failure; the ratio below is the same
    // hazard in a comparison. Both sides are exactly 0.3 per unit.
    expect(
      isUnitPriceAtMost({ amount: '0.300000000000', per: 1 }, { amount: '0.300000000000', per: 1 })
    ).toBe(true);

    // A denominator with no finite decimal reciprocal: 1/3 cannot be written
    // exactly, so any implementation that divided would round here.
    expect(isUnitPriceAtMost({ amount: '1.000000000000', per: 3 }, { amount: '1.000000000000', per: 3 })).toBe(true);
    expect(isUnitPriceAtMost({ amount: '1.000000000001', per: 3 }, { amount: '1.000000000000', per: 3 })).toBe(false);
  });

  it('handles an integer part beyond Number.MAX_SAFE_INTEGER', () => {
    // Cross-multiplication grows the operands, which is exactly where a `number`
    // implementation would start losing digits even for prices that fit.
    expect(
      isUnitPriceAtMost(
        { amount: '9007199254740993.000000000001', per: 1 },
        { amount: '9007199254740993.000000000000', per: 1 }
      )
    ).toBe(false);
  });

  it('refuses rather than guessing when either side is not an exact decimal', () => {
    const price = { amount: '3.00', per: 1_000_000 };
    expect(isUnitPriceAtMost(price, { amount: '', per: 1_000_000 })).toBeUndefined();
    expect(isUnitPriceAtMost(price, { amount: '0.', per: 1_000_000 })).toBeUndefined();
    expect(isUnitPriceAtMost(price, { amount: '1e-6', per: 1_000_000 })).toBeUndefined();
    expect(isUnitPriceAtMost(price, { amount: '-1', per: 1_000_000 })).toBeUndefined();
    expect(isUnitPriceAtMost({ amount: 'abc', per: 1 }, price)).toBeUndefined();
  });

  it('refuses a non-positive or non-integer denominator', () => {
    // `per` divides in every settlement expression; zero is a division by zero
    // and a fraction is not a quantity of units.
    const cap = { amount: '3.00', per: 1_000_000 };
    expect(isUnitPriceAtMost({ amount: '1.00', per: 0 }, cap)).toBeUndefined();
    expect(isUnitPriceAtMost({ amount: '1.00', per: -1 }, cap)).toBeUndefined();
    expect(isUnitPriceAtMost({ amount: '1.00', per: 1.5 }, cap)).toBeUndefined();
    expect(isUnitPriceAtMost({ amount: '1.00', per: 1 }, { amount: '3.00', per: 0 })).toBeUndefined();
  });
});

describe('formatBasisPoints', () => {
  it('renders whole percentages without a decimal', () => {
    expect(formatBasisPoints(10000)).toBe('100%');
    expect(formatBasisPoints(7500)).toBe('75%');
    expect(formatBasisPoints(0)).toBe('0%');
  });

  it('keeps one decimal when the basis points are not a whole percent', () => {
    expect(formatBasisPoints(7532)).toBe('75.3%');
  });
});

describe('formatCount', () => {
  it('groups counts, which are integers and not money', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});
