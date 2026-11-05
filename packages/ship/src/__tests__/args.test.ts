import { test, expect, describe } from 'bun:test';
import {
  parseArgs,
  platformsFlag,
  rolloutFlag,
  stringFlag,
  requireString,
  baseUrlFlag,
  updateMessage,
  UPDATE_MESSAGE_MAX_LENGTH,
} from '../args';

describe('parseArgs', () => {
  test('splits command, flag values, = form, and booleans', () => {
    const parsed = parseArgs([
      'publish',
      '--channel',
      'production',
      '--rollout=50',
      '--dry-run',
      '--message',
      'hello world',
    ]);
    expect(parsed.command).toBe('publish');
    expect(parsed.flags.channel).toBe('production');
    expect(parsed.flags.rollout).toBe('50');
    expect(parsed.flags['dry-run']).toBe(true);
    expect(parsed.flags.message).toBe('hello world');
  });

  test('a boolean flag becomes true and the subcommand is the positional', () => {
    const parsed = parseArgs(['channel:list', '--json']);
    expect(parsed.command).toBe('channel:list');
    expect(parsed.flags.json).toBe(true);
  });

  test('an unknown flag is rejected (strict)', () => {
    expect(() => parseArgs(['publish', '--bogus', 'x'])).toThrow();
  });
});

describe('flag helpers', () => {
  test('platformsFlag defaults to both and validates', () => {
    expect(platformsFlag({})).toEqual(['ios', 'android']);
    expect(platformsFlag({ platform: 'all' })).toEqual(['ios', 'android']);
    expect(platformsFlag({ platform: 'ios' })).toEqual(['ios']);
    expect(() => platformsFlag({ platform: 'windows' })).toThrow();
  });

  test('rolloutFlag parses + range-checks', () => {
    expect(rolloutFlag({})).toBeUndefined();
    expect(rolloutFlag({ rollout: '0' })).toBe(0);
    expect(rolloutFlag({ rollout: '100' })).toBe(100);
    expect(() => rolloutFlag({ rollout: '150' })).toThrow();
    expect(() => rolloutFlag({ rollout: 'abc' })).toThrow();
  });

  test('stringFlag prefers the flag, then env, then default', () => {
    process.env.SHIP_TEST_VAR = 'from-env';
    expect(stringFlag({ x: 'from-flag' }, 'x', 'SHIP_TEST_VAR', 'def')).toBe('from-flag');
    expect(stringFlag({}, 'x', 'SHIP_TEST_VAR', 'def')).toBe('from-env');
    delete process.env.SHIP_TEST_VAR;
    expect(stringFlag({}, 'x', 'SHIP_TEST_VAR', 'def')).toBe('def');
  });

  test('requireString throws when neither flag nor env is set', () => {
    expect(() => requireString({}, 'client-id', 'OXY_SHIP_CLIENT_ID_MISSING')).toThrow(/client-id/);
  });

  test('baseUrlFlag prefers --url, then --api-url/OXY_API_URL, then the default', () => {
    expect(baseUrlFlag({ url: 'http://a' })).toBe('http://a');
    expect(baseUrlFlag({ 'api-url': 'http://b' })).toBe('http://b');
    expect(baseUrlFlag({})).toBe('https://api.oxy.so');
  });
});

describe('updateMessage', () => {
  test('keeps the first non-empty line, trimmed', () => {
    expect(updateMessage('  fix: a thing  \n\nbody\nmore')).toBe('fix: a thing');
    expect(updateMessage('\r\n\n  subject\r\nbody')).toBe('subject');
  });

  test('is undefined for an absent or blank message', () => {
    expect(updateMessage(undefined)).toBeUndefined();
    expect(updateMessage('')).toBeUndefined();
    expect(updateMessage(' \n\t\n')).toBeUndefined();
  });

  test('keeps a line of exactly the limit', () => {
    const line = 'a'.repeat(UPDATE_MESSAGE_MAX_LENGTH);
    expect(updateMessage(line)).toBe(line);
  });

  test('shortens a longer line to the limit with an ellipsis', () => {
    const shortened = updateMessage('b'.repeat(UPDATE_MESSAGE_MAX_LENGTH + 50));
    expect(shortened).toHaveLength(UPDATE_MESSAGE_MAX_LENGTH);
    expect(shortened?.endsWith('…')).toBe(true);
  });

  test('never splits a surrogate pair at the cut', () => {
    // 498 units, then an astral emoji straddling the cut at 499.
    const shortened = updateMessage(
      `${'c'.repeat(UPDATE_MESSAGE_MAX_LENGTH - 2)}😀${'d'.repeat(10)}`,
    );
    expect(shortened?.length).toBeLessThanOrEqual(UPDATE_MESSAGE_MAX_LENGTH);
    expect(shortened).toBe(`${'c'.repeat(UPDATE_MESSAGE_MAX_LENGTH - 2)}…`);
    expect(shortened && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(shortened)).toBe(false);
  });
});
