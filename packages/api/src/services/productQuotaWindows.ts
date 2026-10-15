/** Calendar windows retain the original UTC day/time; February never moves the anchor. */
export function monthlyQuotaWindows(period: { start: string; end: string }) {
  const anchor = new Date(period.start);
  const end = Date.parse(period.end);
  if (!Number.isFinite(+anchor) || !Number.isFinite(end)) throw new Error('Invalid quota period');
  const boundary = (months: number) => {
    const value = new Date(anchor);
    value.setUTCMonth(anchor.getUTCMonth() + months, 1);
    const last = new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
    ).getUTCDate();
    value.setUTCDate(Math.min(anchor.getUTCDate(), last));
    return value;
  };
  if (+boundary(12) !== end) throw new Error('Annual quota period differs from paid calendar year');
  return Array.from({ length: 12 }, (_, month) => ({
    start: boundary(month).toISOString(),
    end: boundary(month + 1).toISOString(),
  }));
}
