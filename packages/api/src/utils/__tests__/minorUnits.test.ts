/**
 * Minor-unit conversion, where every wrong answer is money.
 *
 * The three properties worth falsifying rather than confirming:
 *
 *  1. **The float path is never taken.** `0.07` is the canonical value that
 *     survives `BigInt`/string arithmetic and breaks under `Number(x) * 100`, so
 *     it appears here deliberately rather than as an arbitrary fixture.
 *  2. **An unrepresentable amount is REFUSED, not rounded.** The test asserts
 *     `null` rather than asserting some particular rounding, because the whole
 *     point is that no rounding is correct.
 *  3. **Rounding conserves value.** `rounded + remainder === subtotal` in one
 *     direction and `rounded − remainder === subtotal` in the other; a rounding
 *     helper that got the direction wrong would still round "correctly" and would
 *     book the compensating ledger entry the wrong way.
 */

import {
  CURRENCY_MINOR_UNIT_EXPONENTS,
  UnknownCurrencyExponentError,
  exactDecimalToMinorUnits,
  minorUnitExponentFor,
  minorUnitsToExactDecimal,
  roundExactDecimalToMinorUnits,
  sameExactAmount,
} from '../minorUnits';

describe('minorUnitExponentFor', () => {
  it('knows the currencies this platform transacts in', () => {
    expect(minorUnitExponentFor('USD')).toBe(2);
    expect(minorUnitExponentFor('usd')).toBe(2);
    expect(minorUnitExponentFor('JPY')).toBe(0);
  });

  it('refuses an unregistered currency rather than assuming two', () => {
    // A default of 2 would make a BHD charge ten times too small and a JPY charge
    // a hundred times too small, and every total would still add up.
    expect(() => minorUnitExponentFor('BHD')).toThrow(UnknownCurrencyExponentError);
    expect(CURRENCY_MINOR_UNIT_EXPONENTS.BHD).toBeUndefined();
  });
});

describe('minorUnitsToExactDecimal', () => {
  it('places the decimal point without arithmetic', () => {
    expect(minorUnitsToExactDecimal(1234, 2)).toBe('12.34');
    expect(minorUnitsToExactDecimal(7, 2)).toBe('0.07');
    expect(minorUnitsToExactDecimal(0, 2)).toBe('0.00');
    expect(minorUnitsToExactDecimal(1234, 0)).toBe('1234');
  });

  it('refuses a negative or fractional count', () => {
    expect(() => minorUnitsToExactDecimal(-1, 2)).toThrow();
    expect(() => minorUnitsToExactDecimal(1.5, 2)).toThrow();
  });
});

describe('exactDecimalToMinorUnits', () => {
  it('round-trips the value that breaks float arithmetic', () => {
    // `Number('0.07') * 100` is 7.000000000000001. This path never multiplies.
    expect(exactDecimalToMinorUnits('0.07', 2)).toBe(7);
    expect(minorUnitsToExactDecimal(7, 2)).toBe('0.07');
  });

  it('accepts an amount written at the ledger scale', () => {
    expect(exactDecimalToMinorUnits('20.000000000000', 2)).toBe(2000);
    expect(exactDecimalToMinorUnits('20', 2)).toBe(2000);
  });

  it('REFUSES an amount that does not divide into whole minor units', () => {
    // The assertion is `null`, not a particular rounding: there is no correct
    // rounding of a $20.005 charge, and either choice is a discrepancy the
    // customer finds first.
    expect(exactDecimalToMinorUnits('20.005', 2)).toBeNull();
    expect(exactDecimalToMinorUnits('0.000003', 2)).toBeNull();
  });

  it('refuses an amount too large to count exactly', () => {
    expect(exactDecimalToMinorUnits('999999999999999999', 2)).toBeNull();
  });
});

describe('roundExactDecimalToMinorUnits', () => {
  it('rounds half-up and conserves the value it moved', () => {
    const down = roundExactDecimalToMinorUnits('12.344000000000', 2);
    expect(down).toMatchObject({ minorUnits: 1234, roundedAmount: '12.34', direction: 'rounded_down' });
    // rounded + remainder === subtotal
    expect(down.remainder).toBe('0.004000000000');

    const up = roundExactDecimalToMinorUnits('12.345000000000', 2);
    expect(up).toMatchObject({ minorUnits: 1235, roundedAmount: '12.35', direction: 'rounded_up' });
    // rounded − remainder === subtotal
    expect(up.remainder).toBe('0.005000000000');
  });

  it('reports an exact amount as exact, with a zero remainder', () => {
    const exact = roundExactDecimalToMinorUnits('12.340000000000', 2);
    expect(exact).toEqual({
      minorUnits: 1234,
      roundedAmount: '12.34',
      remainder: '0',
      direction: 'exact',
    });
  });

  it('handles a sub-cent inference charge, which is the real case', () => {
    // A single request can cost less than a cent. Rounding it per request is
    // exactly what the invoice boundary exists to avoid, and this is the shape
    // the boundary receives.
    const tiny = roundExactDecimalToMinorUnits('0.000003000000', 2);
    expect(tiny).toMatchObject({ minorUnits: 0, roundedAmount: '0.00', direction: 'rounded_down' });
    expect(tiny.remainder).toBe('0.000003000000');
  });

  it('rounds a zero-exponent currency at the whole unit', () => {
    const jpy = roundExactDecimalToMinorUnits('1234.500000000000', 0);
    expect(jpy).toMatchObject({ minorUnits: 1235, roundedAmount: '1235', direction: 'rounded_up' });
    expect(jpy.remainder).toBe('0.500000000000');
  });

  it('carries across a minor-unit boundary', () => {
    const carry = roundExactDecimalToMinorUnits('9.999000000000', 2);
    expect(carry).toMatchObject({ minorUnits: 1000, roundedAmount: '10.00', direction: 'rounded_up' });
    expect(carry.remainder).toBe('0.001000000000');
  });
});

describe('sameExactAmount', () => {
  it('compares numerically, so one amount written two ways is one amount', () => {
    // A string comparison here would put a discrepancy on every row of a
    // reconciliation report, and a report full of false findings is one nobody
    // reads — the same outcome as no report.
    expect(sameExactAmount('3.0', '3.000000000000')).toBe(true);
    expect(sameExactAmount('3', '3.000000000000')).toBe(true);
    expect(sameExactAmount('03.00', '3')).toBe(true);
  });

  it('still reports a genuine difference', () => {
    expect(sameExactAmount('3.00', '3.01')).toBe(false);
    expect(sameExactAmount('3.000000000001', '3')).toBe(false);
  });
});
