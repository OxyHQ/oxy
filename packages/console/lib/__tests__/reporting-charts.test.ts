import {
  calendarDays,
  dailyTotals,
  dayLabel,
  deltaChip,
  formatChartMoney,
  formatChartNumber,
  groupTotals,
  plotNumber,
  stackedRanges,
  stackedSeries,
  trendRatio,
  usageTotals,
  windowFromId,
  windowId,
} from '@/lib/reporting-charts';

interface Row {
  day?: string;
  app: string;
  value: number;
}

const options = {
  keyOf: (row: Row) => row.app,
  valueOf: (row: Row) => row.value,
  labelOf: (key: string) => key.toUpperCase(),
  limit: 2,
  otherLabel: 'Other',
};

describe('calendarDays', () => {
  it('lists every UTC day inclusive, oldest first', () => {
    expect(calendarDays({ from: '2026-02-27', to: '2026-03-02' })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('is one day for a one-day range', () => {
    expect(calendarDays({ from: '2026-10-22', to: '2026-10-22' })).toEqual(['2026-10-22']);
  });
});

describe('dayLabel', () => {
  it('names the UTC day regardless of the machine timezone', () => {
    expect(dayLabel('2026-10-22', 'en-US')).toBe('Oct 22');
  });
});

describe('windows', () => {
  it('round-trips the pill id and defaults to 30 days', () => {
    expect(windowFromId(windowId(7))).toBe(7);
    expect(windowFromId(windowId(90))).toBe(90);
    expect(windowFromId('nonsense')).toBe(30);
  });
});

describe('plotNumber', () => {
  it('reads an exact decimal as a coordinate and never produces NaN', () => {
    expect(plotNumber('12.50')).toBe(12.5);
    expect(plotNumber('not money')).toBe(0);
  });
});

describe('dailyTotals', () => {
  it('sums per day and zero-fills quiet days', () => {
    const rows: Row[] = [
      { day: 'd1', app: 'a', value: 2 },
      { day: 'd1', app: 'b', value: 3 },
      { day: 'd3', app: 'a', value: 4 },
      { app: 'a', value: 100 },
    ];
    expect(dailyTotals(rows, ['d1', 'd2', 'd3'], (row) => row.value)).toEqual([5, 0, 4]);
  });
});

describe('groupTotals', () => {
  it('orders keys by size, largest first', () => {
    const rows: Row[] = [
      { app: 'a', value: 1 },
      { app: 'b', value: 9 },
      { app: 'a', value: 4 },
    ];
    expect(
      groupTotals(
        rows,
        (row) => row.app,
        (row) => row.value,
      ),
    ).toEqual([
      { key: 'b', value: 9 },
      { key: 'a', value: 5 },
    ]);
  });
});

describe('stackedSeries', () => {
  const days = ['d1', 'd2'];

  it('gives the largest keys a series each and folds the rest into Other', () => {
    const rows: Row[] = [
      { day: 'd1', app: 'big', value: 10 },
      { day: 'd2', app: 'mid', value: 6 },
      { day: 'd1', app: 'small', value: 2 },
      { day: 'd2', app: 'tiny', value: 1 },
    ];
    const { data, series } = stackedSeries(rows, days, options);

    expect(series.map((entry) => entry.label)).toEqual(['BIG', 'MID', 'Other']);
    expect(data[0]).toMatchObject({ s0: 10, s1: 0, other: 2 });
    expect(data[1]).toMatchObject({ s0: 0, s1: 6, other: 1 });
  });

  it('has no Other series when everything fits', () => {
    const { series } = stackedSeries([{ day: 'd1', app: 'a', value: 1 }], days, options);
    expect(series.map((entry) => entry.key)).toEqual(['s0']);
  });

  it('ignores rows outside the window and keys that never carried traffic', () => {
    const rows: Row[] = [
      { day: 'old', app: 'ghost', value: 50 },
      { day: 'd1', app: 'zero', value: 0 },
      { day: 'd1', app: 'a', value: 3 },
    ];
    const { series, data } = stackedSeries(rows, days, options);
    expect(series.map((entry) => entry.label)).toEqual(['A']);
    expect(data).toHaveLength(2);
  });

  it('returns a labelled zero row per day when there is no data at all', () => {
    const { data, series } = stackedSeries([], days, options);
    expect(series).toEqual([]);
    expect(data.map((point) => point.label)).toEqual([dayLabel('d1'), dayLabel('d2')].map(String));
  });
});

describe('trendRatio', () => {
  it('compares the last window to the one before it', () => {
    expect(trendRatio([1, 1, 2, 2], 2)).toBe(1);
    expect(trendRatio([4, 4, 2, 2], 2)).toBe(-0.5);
  });

  it('is undefined without two full windows or a baseline of zero', () => {
    expect(trendRatio([1, 2, 3], 2)).toBeUndefined();
    expect(trendRatio([0, 0, 5, 5], 2)).toBeUndefined();
  });
});

describe('stackedRanges', () => {
  it('cuts 7, 30 and 90 day ranges from one wide fetch', () => {
    const allDays = calendarDays({ from: '2026-07-25', to: '2026-10-22' });
    expect(allDays).toHaveLength(90);
    const rows: Row[] = allDays.map((day) => ({ day, app: 'a', value: 1 }));

    const ranges = stackedRanges(rows, allDays, options, (days) => `${days}d`);

    expect(ranges.map((range) => range.id)).toEqual(['7d', '30d', '90d']);
    expect(ranges.map((range) => range.data?.length)).toEqual([7, 30, 90]);
    expect(ranges[0]?.delta).toBe(0);
    expect(ranges[2]?.delta).toBeUndefined();
  });
});

describe('deltaChip', () => {
  it('colours by whether the direction is good news', () => {
    expect(deltaChip(0.053, 'up')).toEqual({ delta: '+5.3%', deltaColor: 'lime' });
    expect(deltaChip(0.053, 'down')).toEqual({ delta: '+5.3%', deltaColor: 'rose' });
    expect(deltaChip(-0.2, 'down')).toEqual({ delta: '-20.0%', deltaColor: 'lime' });
  });

  it('keeps spend-like figures neutral and says nothing without a baseline', () => {
    expect(deltaChip(0.5, 'neutral').deltaColor).toBe('neutral');
    expect(deltaChip(undefined)).toEqual({ delta: '—', deltaColor: 'neutral' });
    expect(deltaChip(0.0001).delta).toBe('0%');
  });
});

describe('chart number formatting', () => {
  it('keeps small amounts from reading as zero', () => {
    expect(formatChartNumber(0.000003)).toBe('0.000003');
    expect(formatChartNumber(0.5)).toBe('0.5');
    expect(formatChartNumber(1234.567)).toBe('1,234.57');
    expect(formatChartNumber(0)).toBe('0');
  });

  it('puts the currency code after the number, like every other amount', () => {
    expect(formatChartMoney(12.5, 'USD')).toBe('12.5 USD');
  });
});

describe('usageTotals', () => {
  const units = {
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 5,
    reasoning_tokens: 2,
    requests: 1,
    images: 0,
    audio_input_milliseconds: 0,
    audio_output_milliseconds: 0,
    video_milliseconds: 0,
    characters: 0,
    embeddings: 0,
    audio_input_tokens: 0,
    cached_audio_input_tokens: 0,
    audio_output_tokens: 0,
    session_milliseconds: 0,
    input_transcription_milliseconds: 0,
  };

  it('collapses rows per key and orders by requests', () => {
    const rows = [
      { applicationId: 'a', requestCount: 1, errorCount: 0, units },
      { applicationId: 'b', requestCount: 5, errorCount: 1, units },
      { applicationId: 'a', requestCount: 2, errorCount: 1, units },
    ];
    expect(usageTotals(rows, (row) => row.applicationId ?? '')).toEqual([
      { key: 'b', requests: 5, errors: 1, inputTokens: 10, outputTokens: 5, reasoningTokens: 2 },
      { key: 'a', requests: 3, errors: 1, inputTokens: 20, outputTokens: 10, reasoningTokens: 4 },
    ]);
  });
});
