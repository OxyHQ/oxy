/** Format integer authorization evidence without rounding it through a floating-point division. */
export function formatApprovalAmount(minor: number, currency: string, locale: string): string {
  const digits =
    new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const value = BigInt(minor),
    absolute = value < 0n ? -value : value,
    scale = 10n ** BigInt(digits);
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    absolute / scale,
  );
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')
      ?.value ?? '.';
  const fraction = digits ? `${decimal}${(absolute % scale).toString().padStart(digits, '0')}` : '';
  return `${value < 0n ? '-' : ''}${whole}${fraction} ${currency}`;
}
