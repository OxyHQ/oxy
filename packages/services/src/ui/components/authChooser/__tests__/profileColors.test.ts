import { resolveAccentHex } from '../types';
import { APP_COLOR_PRESETS } from '@oxy.so/bloom/color-presets';

jest.mock('@oxy.so/bloom/theme', () => jest.requireActual('@oxy.so/bloom/color-presets'));

it('preserves the account identity for every app using the shared chooser', () => {
  expect(resolveAccentHex('grove', '#fff')).toBe(APP_COLOR_PRESETS.grove.hex);
  expect(resolveAccentHex('amber', '#fff')).toBe(APP_COLOR_PRESETS.yellow.hex);
  expect(resolveAccentHex('#ABC', '#fff')).toBe('#aabbcc');
  expect(resolveAccentHex('#123456', '#fff')).toBe('#123456');
  expect(resolveAccentHex(null, '#fff')).toBe('#fff');
  expect(resolveAccentHex('unknown', '#fff')).toBe('#fff');
});
