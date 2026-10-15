import { monthlyQuotaWindows } from '../productQuotaWindows';

it.each([
  [
    '2028-01-31T12:34:56.123Z',
    '2029-01-31T12:34:56.123Z',
    '2028-02-29T12:34:56.123Z',
    '2028-03-31T12:34:56.123Z',
  ],
  [
    '2028-02-29T12:34:56.123Z',
    '2029-02-28T12:34:56.123Z',
    '2028-03-29T12:34:56.123Z',
    '2028-04-29T12:34:56.123Z',
  ],
])(
  'retains the paid calendar anchor %s without early annual allowance',
  (start, end, second, third) => {
    const windows = monthlyQuotaWindows({ start, end });
    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual({ start, end: second });
    expect(windows[1]).toEqual({ start: second, end: third });
    expect(windows[11].end).toBe(end);
    for (let i = 1; i < windows.length; i++) expect(windows[i].start).toBe(windows[i - 1].end);
  },
);
it('rejects a window outside its exact paid year', () => {
  expect(() =>
    monthlyQuotaWindows({ start: '2028-01-31T00:00:00Z', end: '2029-02-01T00:00:00Z' }),
  ).toThrow('paid calendar year');
});
