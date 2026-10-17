import {
  FAIR_CODE,
  FAIR_DECIMALS,
  FAIR_SYMBOL,
  convertAmount,
  currencyDisplayDigits,
  currencyName,
  currencyStorageDigits,
  formatMoney,
  formatMoneyRange,
  fromMinorUnits,
  isIsoCurrencyCode,
  toMinorUnits,
} from '../currency';

// `Intl`'s exact output moves with the engine's ICU (the space before `€` is
// U+00A0 and became U+202F in some locales across releases; `es` stopped
// grouping four-digit numbers). Where a whole string would pin ICU rather than
// this module, the cases assert the properties that decide correctness: which
// marker, which side, which decimal separator, which digits. `en-US` strings
// have been stable for years and are pinned whole.

const NBSP = ' ';

describe('FAIR constants', () => {
  it('names the code, the glyph and the STORAGE precision', () => {
    expect(FAIR_CODE).toBe('FAIR');
    expect(FAIR_SYMBOL).toBe('⊜');
    expect(FAIR_DECIMALS).toBe(8);
  });
});

describe('formatMoney — the locale decides the shape, the currency is the amount’s own', () => {
  it('en-US: symbol first, comma groups, point decimal', () => {
    expect(formatMoney(1234.56, 'EUR', 'en-US')).toBe('€1,234.56');
    expect(formatMoney(1234567.891, 'USD', 'en-US')).toBe('$1,234,567.89');
  });

  it('es-ES: euro AFTER the amount, comma decimal', () => {
    const text = formatMoney(1234.56, 'EUR', 'es-ES');
    expect(text.endsWith('€')).toBe(true);
    expect(text).toMatch(/^1\.?234,56\s€$/);
    // es groups from five digits: the separator is the locale's, not ours.
    expect(formatMoney(12345.67, 'EUR', 'es-ES')).toMatch(/^12\.345,67\s€$/);
  });

  it('de-DE: point groups, comma decimal, euro after', () => {
    expect(formatMoney(1234.56, 'EUR', 'de-DE')).toMatch(/^1\.234,56\s€$/);
    expect(formatMoney(1234.56, 'USD', 'de-DE')).toMatch(/^1\.234,56\s\$$/);
  });

  it('ja-JP: yen has no fraction digits and rounds', () => {
    const text = formatMoney(1234.5, 'JPY', 'ja-JP');
    expect(text).toMatch(/^[¥￥]1,235$/);
    expect(formatMoney(1234.56, 'USD', 'ja-JP')).toMatch(/1,234\.56/);
  });

  it('never infers the currency from the locale', () => {
    expect(formatMoney(1700, 'EUR', 'en-US')).toContain('€');
    expect(formatMoney(1700, 'USD', 'es-ES')).not.toContain('€');
  });

  it('defaults to the currency’s display digits, overridable either way', () => {
    expect(formatMoney(1700, 'EUR', 'en-US')).toBe('€1,700.00');
    expect(formatMoney(1700, 'EUR', 'en-US', { minimumFractionDigits: 0 })).toBe('€1,700');
    expect(formatMoney(1700.5, 'EUR', 'en-US', { minimumFractionDigits: 0 })).toBe('€1,700.5');
    expect(formatMoney(1.23456, 'USD', 'en-US', { maximumFractionDigits: 4 })).toBe('$1.2346');
    // A maximum below the default pulls the minimum down with it instead of
    // asking `Intl` for min 2 / max 0, which throws on older engines.
    expect(formatMoney(1700.4, 'EUR', 'en-US', { maximumFractionDigits: 0 })).toBe('€1,700');
    // A minimum above the maximum wins rather than throwing.
    expect(
      formatMoney(1, 'EUR', 'en-US', { minimumFractionDigits: 3, maximumFractionDigits: 1 }),
    ).toBe('€1.000');
  });

  it('spells the currency out for accessibility labels', () => {
    expect(formatMoney(1700, 'EUR', 'es-ES', { currencyDisplay: 'name' })).toContain('euros');
    expect(formatMoney(2, 'USD', 'en-US', { currencyDisplay: 'code' })).toMatch(/^USD\s2\.00$/);
  });

  it('accepts a lowercase or padded code', () => {
    expect(formatMoney(5, ' eur ', 'en-US')).toBe('€5.00');
  });

  it('renders a non-finite amount as zero, and never a negative zero', () => {
    expect(formatMoney(Number.NaN, 'EUR', 'en-US')).toBe('€0.00');
    expect(formatMoney(Number.POSITIVE_INFINITY, 'EUR', 'en-US')).toBe('€0.00');
    expect(formatMoney(-0, 'EUR', 'en-US')).toBe('€0.00');
    expect(formatMoney(-0.001, 'EUR', 'en-US')).toBe('€0.00');
    expect(formatMoney(-0.001, 'FAIR', 'en-US')).toBe(`0.00${NBSP}FAIR`);
    expect(formatMoney(-250, 'USD', 'en-US')).toMatch(/^[-−]\$250\.00$/);
  });

  it('does not throw on a malformed locale tag', () => {
    expect(() => formatMoney(1700, 'EUR', 'en_US')).not.toThrow();
    expect(formatMoney(1700, 'EUR', 'en_US')).toMatch(/1.?700/);
    expect(() => formatMoney(1700, 'FAIR', 'not a locale')).not.toThrow();
  });
});

describe('formatMoney — FAIR: stored at 8, shown at 2', () => {
  it('displays two decimals whatever precision the amount carries', () => {
    expect(formatMoney(12.3456789, 'FAIR', 'en-US')).toBe(`12.35${NBSP}FAIR`);
    expect(formatMoney(fromMinorUnits(1_234_567_890, 'FAIR') ?? 0, 'FAIR', 'en-US')).toBe(
      `12.35${NBSP}FAIR`,
    );
    expect(formatMoney(12.3456789, 'FAIR', 'en-US')).not.toMatch(/\d{3,}\s?FAIR/);
  });

  it('writes AMOUNT then CODE, the number in the locale’s own shape', () => {
    expect(formatMoney(1234.56, 'FAIR', 'de-DE')).toBe(`1.234,56${NBSP}FAIR`);
    expect(formatMoney(1234.56, 'FAIR', 'en-US')).toBe(`1,234.56${NBSP}FAIR`);
    expect(formatMoney(1234.56, 'FAIR', 'es-ES')).toMatch(new RegExp(`^1\\.?234,56${NBSP}FAIR$`));
    expect(formatMoney(1234.56, 'FAIR', 'ja-JP')).toBe(`1,234.56${NBSP}FAIR`);
  });

  it('never invents a symbol: not ⊜, not €', () => {
    const text = formatMoney(5, 'FAIR', 'en-US');
    expect(text).not.toContain(FAIR_SYMBOL);
    expect(text).not.toContain('€');
  });

  it('spells FAIR as FairCoin when asked for a name', () => {
    expect(formatMoney(3, 'fair', 'en-US', { currencyDisplay: 'name' })).toBe(
      `3.00${NBSP}FairCoin`,
    );
  });

  it('honours an explicit digits override like any other currency', () => {
    expect(formatMoney(12, 'FAIR', 'en-US', { minimumFractionDigits: 0 })).toBe(`12${NBSP}FAIR`);
  });
});

describe('formatMoney — codes Intl cannot format', () => {
  it('falls back to amount + code and never throws', () => {
    expect(formatMoney(1234.5, 'XBTC', 'de-DE')).toBe(`1.234,50${NBSP}XBTC`);
    // Inbox's extractor hands over bare symbols; the row must still render.
    expect(formatMoney(12.5, '$', 'en-US')).toBe(`12.50${NBSP}$`);
  });

  it('renders the bare number when there is no code at all', () => {
    expect(formatMoney(12.5, '', 'en-US')).toBe('12.50');
    expect(formatMoney(12.5, '   ', 'en-US')).toBe('12.50');
  });

  it('lets Intl format a well-formed code it does not know, the same on every engine', () => {
    // No engine checks the ISO list, so this takes Intl's own path everywhere.
    expect(formatMoney(5, 'ZZZ', 'en-US')).toMatch(/^ZZZ\s5\.00$/);
  });
});

describe('formatMoneyRange', () => {
  it('joins both ends in one currency with an en dash', () => {
    expect(formatMoneyRange(500, 1200, 'EUR', 'en-US')).toBe('€500.00–€1,200.00');
    expect(formatMoneyRange(500, 1200, 'EUR', 'en-US', { minimumFractionDigits: 0 })).toBe(
      '€500–€1,200',
    );
  });

  it('follows the locale on both ends', () => {
    const text = formatMoneyRange(500, 1200, 'EUR', 'de-DE');
    expect(text).toMatch(/^500,00\s€–1\.200,00\s€$/);
  });

  it('formats FAIR ranges with the fallback on both ends', () => {
    expect(formatMoneyRange(1, 2.5, 'FAIR', 'en-US')).toBe(`1.00${NBSP}FAIR–2.50${NBSP}FAIR`);
  });

  it('returns the one end present, and nothing when neither is', () => {
    expect(formatMoneyRange(null, 1200, 'EUR', 'en-US')).toBe('€1,200.00');
    expect(formatMoneyRange(500, undefined, 'EUR', 'en-US')).toBe('€500.00');
    expect(formatMoneyRange(null, null, 'EUR', 'en-US')).toBe('');
    expect(formatMoneyRange(Number.NaN, undefined, 'EUR', 'en-US')).toBe('');
  });

  it('collapses ends that read the same', () => {
    expect(formatMoneyRange(500, 500, 'EUR', 'en-US')).toBe('€500.00');
    expect(formatMoneyRange(1000, 1000.4, 'JPY', 'en-US')).toBe('¥1,000');
  });
});

describe('isIsoCurrencyCode', () => {
  it('knows ISO codes, case- and whitespace-insensitively', () => {
    expect(isIsoCurrencyCode('EUR')).toBe(true);
    expect(isIsoCurrencyCode(' jpy ')).toBe(true);
  });

  it('rejects FAIR and malformed codes', () => {
    expect(isIsoCurrencyCode('FAIR')).toBe(false);
    expect(isIsoCurrencyCode('')).toBe(false);
    expect(isIsoCurrencyCode('EU')).toBe(false);
    expect(isIsoCurrencyCode('€')).toBe(false);
    expect(isIsoCurrencyCode('E1R')).toBe(false);
  });

  it('rejects a well-formed code that is not ISO, where the engine lists currencies', () => {
    const intl = Intl as { supportedValuesOf?: unknown };
    if (typeof intl.supportedValuesOf !== 'function') return;
    expect(isIsoCurrencyCode('ZZZ')).toBe(false);
  });
});

describe('display digits vs storage digits', () => {
  it('display comes from Intl, FAIR shows 2', () => {
    expect(currencyDisplayDigits('EUR')).toBe(2);
    expect(currencyDisplayDigits('USD')).toBe(2);
    expect(currencyDisplayDigits('JPY')).toBe(0);
    expect(currencyDisplayDigits('KWD')).toBe(3);
    expect(currencyDisplayDigits('FAIR')).toBe(2);
    expect(currencyDisplayDigits('nope!')).toBe(2);
  });

  it('storage is FAIR 8 and the ISO exponent otherwise', () => {
    expect(currencyStorageDigits('FAIR')).toBe(8);
    expect(currencyStorageDigits('fair')).toBe(8);
    expect(currencyStorageDigits('EUR')).toBe(2);
    expect(currencyStorageDigits('JPY')).toBe(0);
    expect(currencyStorageDigits('KWD')).toBe(3);
    expect(currencyStorageDigits('CLF')).toBe(4);
  });

  it('storage does not follow CLDR where CLDR displays fewer digits than ISO stores', () => {
    // IQD is 3 in ISO 4217 and displays 0 in CLDR; a stored integer must not
    // change meaning with the engine's ICU.
    expect(currencyStorageDigits('IQD')).toBe(3);
    expect(currencyDisplayDigits('IQD')).not.toBe(3);
  });

  it('refuses to guess the storage precision of an unknown code', () => {
    expect(currencyStorageDigits('XBTC')).toBeNull();
    expect(currencyStorageDigits('')).toBeNull();
  });
});

describe('currencyName', () => {
  it('names a currency in the reader’s language', () => {
    expect(currencyName('EUR', 'es-ES')).toBe('euro');
    expect(currencyName('EUR', 'en-US')).toBe('Euro');
    expect(currencyName('USD', 'de-DE')).toBe('US-Dollar');
    expect(currencyName('JPY', 'ja-JP')).toBe('日本円');
  });

  it('names FAIR, and falls back to the code for anything else', () => {
    expect(currencyName('FAIR', 'es-ES')).toBe('FairCoin');
    expect(currencyName('xbtc', 'en-US')).toBe('XBTC');
    expect(currencyName('', 'en-US')).toBe('');
  });

  it('does not throw on a malformed locale', () => {
    expect(() => currencyName('EUR', 'en_US')).not.toThrow();
    expect(currencyName('EUR', 'en_US')).toBeTruthy();
  });
});

describe('toMinorUnits / fromMinorUnits', () => {
  it('scales by STORAGE precision', () => {
    expect(toMinorUnits(12.5, 'EUR')).toBe(1250);
    expect(toMinorUnits(1, 'FAIR')).toBe(100_000_000);
    expect(toMinorUnits(148, 'FAIR')).toBe(14_800_000_000);
    expect(toMinorUnits(100, 'JPY')).toBe(100);
    expect(toMinorUnits(1.234, 'KWD')).toBe(1234);
  });

  it('rounds the decimal the caller wrote, not its binary approximation', () => {
    // 1.005 * 100 is 100.49999999999999.
    expect(toMinorUnits(1.005, 'EUR')).toBe(101);
    // 0.1 * 1e8 is 10000000.000000002.
    expect(toMinorUnits(0.1, 'FAIR')).toBe(10_000_000);
    expect(toMinorUnits(0.00000001, 'FAIR')).toBe(1);
    expect(toMinorUnits(1e-9, 'FAIR')).toBe(0);
  });

  it('breaks ties away from zero by default, to even on request', () => {
    expect(toMinorUnits(2.5, 'JPY')).toBe(3);
    expect(toMinorUnits(-2.5, 'JPY')).toBe(-3);
    expect(toMinorUnits(2.5, 'JPY', { rounding: 'halfEven' })).toBe(2);
    expect(toMinorUnits(3.5, 'JPY', { rounding: 'halfEven' })).toBe(4);
    expect(toMinorUnits(-2.5, 'JPY', { rounding: 'halfEven' })).toBe(-2);
    expect(toMinorUnits(0.125, 'EUR', { rounding: 'halfEven' })).toBe(12);
    expect(toMinorUnits(-0.4, 'JPY')).toBe(0);
    expect(Object.is(toMinorUnits(-0.4, 'JPY'), -0)).toBe(false);
  });

  it('returns null rather than a wrong integer', () => {
    expect(toMinorUnits(Number.NaN, 'EUR')).toBeNull();
    expect(toMinorUnits(Number.POSITIVE_INFINITY, 'EUR')).toBeNull();
    expect(toMinorUnits(5, 'XBTC')).toBeNull();
    // ~90 million FAIR is where 8-decimal integers stop being exact.
    expect(toMinorUnits(100_000_000, 'FAIR')).toBeNull();
    expect(toMinorUnits(90_000_000, 'FAIR')).toBe(9_000_000_000_000_000);
  });

  it('reads minor units back, from number or ledger bigint', () => {
    expect(fromMinorUnits(1250, 'EUR')).toBe(12.5);
    expect(fromMinorUnits(100_000_000, 'FAIR')).toBe(1);
    expect(fromMinorUnits(1, 'FAIR')).toBe(0.00000001);
    expect(fromMinorUnits(100, 'JPY')).toBe(100);
    expect(fromMinorUnits(BigInt(123_456_789), 'FAIR')).toBe(1.23456789);
    expect(fromMinorUnits(BigInt(-150), 'EUR')).toBe(-1.5);
    expect(fromMinorUnits(BigInt(7), 'FAIR')).toBe(0.00000007);
    expect(fromMinorUnits(BigInt(42), 'JPY')).toBe(42);
  });

  it('refuses a fractional minor unit or an unknown precision', () => {
    expect(fromMinorUnits(12.5, 'EUR')).toBeNull();
    expect(fromMinorUnits(Number.NaN, 'EUR')).toBeNull();
    expect(fromMinorUnits(1250, 'XBTC')).toBeNull();
  });

  it('round-trips at every storage precision', () => {
    for (const [amount, code] of [
      [19.99, 'USD'],
      [12.34567891, 'FAIR'],
      [1500, 'JPY'],
      [0.125, 'BHD'],
      [-42.42, 'EUR'],
    ] as const) {
      const minor = toMinorUnits(amount, code);
      expect(minor).not.toBeNull();
      expect(fromMinorUnits(minor ?? 0, code)).toBe(amount);
    }
  });
});

describe('convertAmount — rates are injected, never fetched or fabricated', () => {
  // A FAIR-based table: 1 FAIR = 0.5 EUR = 0.55 USD.
  const fairBased = { base: 'FAIR', rates: { EUR: 0.5, USD: 0.55 } };

  it('converts from and to the base', () => {
    expect(convertAmount(10, 'FAIR', 'EUR', fairBased)).toBe(5);
    expect(convertAmount(5, 'EUR', 'FAIR', fairBased)).toBe(10);
  });

  it('crosses two non-base currencies through the base', () => {
    // 100 EUR = 200 FAIR = 110 USD. Unrounded: round once where it is shown.
    expect(convertAmount(100, 'EUR', 'USD', fairBased)).toBeCloseTo(110, 10);
    expect(toMinorUnits(convertAmount(100, 'EUR', 'USD', fairBased) ?? 0, 'USD')).toBe(11_000);
  });

  it('works whichever currency the table is based on', () => {
    const eurBased = { base: 'EUR', rates: { USD: 1.1, FAIR: 2 } };
    expect(convertAmount(10, 'FAIR', 'USD', eurBased)).toBeCloseTo(5.5, 10);
    expect(convertAmount(10, 'fair', ' usd ', eurBased)).toBeCloseTo(5.5, 10);
  });

  it('returns the same currency untouched, even with no rates at all', () => {
    expect(convertAmount(12.345, 'EUR', 'EUR', { base: 'USD', rates: {} })).toBe(12.345);
  });

  it('returns null instead of assuming a rate of 1', () => {
    expect(convertAmount(10, 'EUR', 'GBP', fairBased)).toBeNull();
    expect(convertAmount(10, 'GBP', 'EUR', fairBased)).toBeNull();
    expect(convertAmount(10, 'EUR', 'USD', { base: 'FAIR', rates: { EUR: 0, USD: 1 } })).toBeNull();
    expect(
      convertAmount(10, 'EUR', 'USD', { base: 'FAIR', rates: { EUR: Number.NaN, USD: 1 } }),
    ).toBeNull();
    expect(convertAmount(Number.NaN, 'EUR', 'USD', fairBased)).toBeNull();
  });
});
