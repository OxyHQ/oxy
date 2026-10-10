import { prettyActionType, payloadEntries } from '@/lib/civic/validation-format';

describe('prettyActionType', () => {
  it('turns a snake_case action into a Title Case label', () => {
    expect(prettyActionType('real_life_attested')).toBe('Real Life Attested');
  });

  it('handles kebab-case and empty input', () => {
    expect(prettyActionType('peer-validated')).toBe('Peer Validated');
    expect(prettyActionType('')).toBe('');
  });
});

describe('payloadEntries', () => {
  it('flattens a payload into prettified key + stringified value rows', () => {
    expect(payloadEntries({ subject_user: 'u1', points: 25, ok: true })).toEqual([
      { key: 'Subject User', value: 'u1' },
      { key: 'Points', value: '25' },
      { key: 'Ok', value: 'true' },
    ]);
  });

  it('JSON-stringifies object values and renders nullish as a dash', () => {
    expect(payloadEntries({ meta: { a: 1 }, missing: null })).toEqual([
      { key: 'Meta', value: '{"a":1}' },
      { key: 'Missing', value: '—' },
    ]);
  });
});
