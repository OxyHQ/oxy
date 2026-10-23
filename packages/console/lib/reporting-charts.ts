/**
 * Shapes reporting rows into what Bloom's chart components take.
 *
 * ## Plot values are not amounts
 *
 * `lib/money.ts` keeps every amount an exact decimal string and has no `add`. A
 * chart cannot: it positions marks on a numeric axis. {@link plotNumber} is the
 * ONE place a ledger string becomes a `number`, and what it produces is only ever
 * drawn or summed for a hover readout. A figure a customer reads as money (a KPI
 * card, a table cell, a bill) is always the server's own string through
 * `formatMoney`; the server also supplies the per-currency totals, so no page
 * adds amounts to make a headline.
 *
 * Usage counts are integers, so summing them here is exact.
 */
import type { AreaPoint, AreaRange, AreaSeries } from '@oxy.so/bloom/chart-cards';
import type { StatCardsDeltaColor } from '@oxy.so/bloom/stat-cards';
import type { DayRange, UsageRow } from '@/lib/reporting';

/** The windows a chart's period pill offers. The overview fetches the widest once. */
export const CHART_WINDOWS = [7, 30, 90] as const;
export type ChartWindow = (typeof CHART_WINDOWS)[number];

/** The id Bloom's range pill reports for a window (`30d`). */
export function windowId(days: ChartWindow): string {
  return `${days}d`;
}

export function windowFromId(id: string): ChartWindow {
  return CHART_WINDOWS.find((days) => windowId(days) === id) ?? 30;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every UTC calendar day of a range, oldest first, so a quiet day is a zero and not a gap. */
export function calendarDays(range: DayRange): string[] {
  const days: string[] = [];
  const end = Date.parse(`${range.to}T00:00:00Z`);
  for (let at = Date.parse(`${range.from}T00:00:00Z`); at <= end; at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** `Oct 22` — the X label and hovered title of a day. UTC, like the rollups. */
export function dayLabel(day: string, locale: string = 'en-US'): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const LEGEND_LABEL_MAX = 28;

/** A series name short enough for a chart legend row, which does not wrap or clip a long one. */
export function legendLabel(label: string): string {
  return label.length <= LEGEND_LABEL_MAX ? label : `${label.slice(0, LEGEND_LABEL_MAX - 1).trimEnd()}…`;
}

/** An exact decimal string as a plot coordinate. Never shown as an amount. */
export function plotNumber(amount: string): number {
  const value = Number(amount);
  return Number.isFinite(value) ? value : 0;
}

interface DayRow {
  readonly day?: string;
}

/** One value per day of `days`, summing the rows that fall on it. */
export function dailyTotals<Row extends DayRow>(
  rows: ReadonlyArray<Row>,
  days: ReadonlyArray<string>,
  valueOf: (row: Row) => number,
): number[] {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.day !== undefined) {
      byDay.set(row.day, (byDay.get(row.day) ?? 0) + valueOf(row));
    }
  }
  return days.map((day) => byDay.get(day) ?? 0);
}

/** `{ key, value }` per distinct key, largest first. */
export function groupTotals<Row>(
  rows: ReadonlyArray<Row>,
  keyOf: (row: Row) => string,
  valueOf: (row: Row) => number,
): Array<{ key: string; value: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    totals.set(key, (totals.get(key) ?? 0) + valueOf(row));
  }
  return [...totals.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value - left.value);
}

export interface StackedOptions<Row> {
  readonly keyOf: (row: Row) => string;
  readonly valueOf: (row: Row) => number;
  /** Display name of a key (an application id becomes its name). */
  readonly labelOf: (key: string) => string;
  /** How many keys keep a series of their own; the rest are folded into one. */
  readonly limit: number;
  readonly otherLabel: string;
  /** The locale of the day labels on the X axis. */
  readonly locale?: string;
}

/**
 * Area-chart data stacked by a dimension: the `limit` largest keys of the window
 * get a series each, everything else is one `Other` series on top, so the legend
 * stays readable however many applications or models an account has.
 */
export function stackedSeries<Row extends DayRow>(
  rows: ReadonlyArray<Row>,
  days: ReadonlyArray<string>,
  options: StackedOptions<Row>,
): { data: AreaPoint[]; series: AreaSeries[] } {
  const inWindow = rows.filter((row) => row.day !== undefined && days.includes(row.day));
  const ranked = groupTotals(inWindow, options.keyOf, options.valueOf).filter(
    (entry) => entry.value > 0,
  );
  const named = ranked.slice(0, options.limit);
  const namedKeys = new Set(named.map((entry) => entry.key));
  const hasOther = ranked.length > named.length;

  const series: AreaSeries[] = named.map((entry, index) => ({
    key: `s${index}`,
    label: legendLabel(options.labelOf(entry.key)),
  }));
  if (hasOther) {
    series.push({ key: 'other', label: options.otherLabel });
  }

  const cells = new Map<string, number>();
  for (const row of inWindow) {
    const key = options.keyOf(row);
    const seriesIndex = namedKeys.has(key) ? named.findIndex((entry) => entry.key === key) : -1;
    const seriesKey = seriesIndex === -1 ? 'other' : `s${seriesIndex}`;
    const cell = `${row.day}|${seriesKey}`;
    cells.set(cell, (cells.get(cell) ?? 0) + options.valueOf(row));
  }

  const data = days.map((day) => {
    const point: AreaPoint = { label: dayLabel(day, options.locale) };
    for (const entry of series) {
      point[entry.key] = cells.get(`${day}|${entry.key}`) ?? 0;
    }
    return point;
  });

  return { data, series };
}

/** The share the last `window` values moved against the `window` before them. */
export function trendRatio(values: ReadonlyArray<number>, window: number): number | undefined {
  if (values.length < window * 2) {
    return undefined;
  }
  const sum = (slice: ReadonlyArray<number>) => slice.reduce((total, value) => total + value, 0);
  const latest = sum(values.slice(-window));
  const previous = sum(values.slice(-window * 2, -window));
  return previous === 0 ? undefined : (latest - previous) / previous;
}

/**
 * The period pill's three ranges, each carrying its own stacked data, headline
 * delta and series, cut from one wide fetch.
 */
export function stackedRanges<Row extends DayRow>(
  rows: ReadonlyArray<Row>,
  allDays: ReadonlyArray<string>,
  options: StackedOptions<Row>,
  labelOfWindow: (days: ChartWindow) => string,
): AreaRange[] {
  const totals = dailyTotals(rows, allDays, options.valueOf);
  return CHART_WINDOWS.map((window) => {
    const { data, series } = stackedSeries(rows, allDays.slice(-window), options);
    const delta = trendRatio(totals, window);
    return {
      id: windowId(window),
      label: labelOfWindow(window),
      data,
      series,
      ...(delta === undefined ? {} : { delta }),
    };
  });
}

/** A delta chip for a StatCards tile. `better` says which direction is good news. */
export function deltaChip(
  ratio: number | undefined,
  better: 'up' | 'down' | 'neutral' = 'up',
): { delta: string; deltaColor: StatCardsDeltaColor } {
  if (ratio === undefined) {
    return { delta: '—', deltaColor: 'neutral' };
  }
  const percent = ratio * 100;
  if (Math.abs(percent) < 0.05) {
    return { delta: '0%', deltaColor: 'neutral' };
  }
  const delta = `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
  if (better === 'neutral') {
    return { delta, deltaColor: 'neutral' };
  }
  const good = (percent > 0) === (better === 'up');
  return { delta, deltaColor: good ? 'lime' : 'rose' };
}

/**
 * A plot value as text: grouped, with as many decimals as it takes to not read
 * as zero. A per-token price of `0.000003` must not render as `0.00`.
 */
export function formatChartNumber(value: number, locale: string = 'en-US'): string {
  const magnitude = Math.abs(value);
  const maximumFractionDigits = magnitude === 0 || magnitude >= 1 ? 2 : magnitude >= 0.01 ? 4 : 6;
  return value.toLocaleString(locale, { maximumFractionDigits });
}

export function formatChartMoney(value: number, currency: string, locale: string = 'en-US'): string {
  return `${formatChartNumber(value, locale)} ${currency}`;
}

/** One breakdown key's counts over a period. Integers, so the sums are exact. */
export interface UsageTotals {
  readonly key: string;
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/** The usage rows collapsed per key, busiest first. */
export function usageTotals(
  rows: ReadonlyArray<UsageRow>,
  keyOf: (row: UsageRow) => string,
): UsageTotals[] {
  const byKey = new Map<string, UsageTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = byKey.get(key);
    byKey.set(key, {
      key,
      requests: (current?.requests ?? 0) + row.requestCount,
      errors: (current?.errors ?? 0) + row.errorCount,
      inputTokens: (current?.inputTokens ?? 0) + row.units.input_tokens,
      outputTokens: (current?.outputTokens ?? 0) + row.units.output_tokens,
      reasoningTokens: (current?.reasoningTokens ?? 0) + row.units.reasoning_tokens,
    });
  }
  return [...byKey.values()].sort((left, right) => right.requests - left.requests);
}
