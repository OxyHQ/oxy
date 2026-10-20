import {
  FREE_USER_PROFILE_COLOR_PRESETS,
  USER_PROFILE_COLOR_PRESETS,
  USER_PROFILE_COLORS,
} from '../profileColors.generated';

it('exports the complete generated catalogue without assigning reserved identities', () => {
  expect(USER_PROFILE_COLOR_PRESETS).toContain('yellow');
  expect(USER_PROFILE_COLOR_PRESETS).toContain('grove');
  expect(USER_PROFILE_COLOR_PRESETS).not.toContain('amber');
  for (const preset of USER_PROFILE_COLORS) {
    expect(FREE_USER_PROFILE_COLOR_PRESETS.includes(preset.name)).toBe(preset.gate === null);
  }
});
