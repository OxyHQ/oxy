import { FAIRCOIN_SYMBOL, formatFairCoinBalance, isCreditTransaction } from '@/utils/payment-utils';

describe('formatFairCoinBalance', () => {
  it('prefixes the FairCoin glyph and formats to two decimals', () => {
    expect(formatFairCoinBalance(12.5)).toBe(`${FAIRCOIN_SYMBOL} 12.50`);
  });

  it('formats a zero balance', () => {
    expect(formatFairCoinBalance(0)).toBe(`${FAIRCOIN_SYMBOL} 0.00`);
  });

  it('rounds to two decimal places', () => {
    expect(formatFairCoinBalance(1.005)).toBe(`${FAIRCOIN_SYMBOL} 1.00`);
    expect(formatFairCoinBalance(2.346)).toBe(`${FAIRCOIN_SYMBOL} 2.35`);
  });

  it('handles negative balances', () => {
    expect(formatFairCoinBalance(-3.2)).toBe(`${FAIRCOIN_SYMBOL} -3.20`);
  });
});

describe('isCreditTransaction', () => {
  it.each(['credit', 'deposit', 'refund'])('treats %s as a credit', (type) => {
    expect(isCreditTransaction(type)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCreditTransaction('DEPOSIT')).toBe(true);
    expect(isCreditTransaction('Refund')).toBe(true);
  });

  it.each(['withdrawal', 'transfer', 'purchase', 'debit'])('treats %s as a debit', (type) => {
    expect(isCreditTransaction(type)).toBe(false);
  });

  it('returns false for an undefined type', () => {
    expect(isCreditTransaction(undefined)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isCreditTransaction('')).toBe(false);
  });
});
