import { readFileSync, writeFileSync } from 'node:fs';
import { COLOR_PRESET_REGISTRY } from '@oxy.so/bloom/color-presets';

// Bloom is a BUILD dependency only. Contracts stays platform-neutral and ships
// no React or React Native dependency to servers and non-UI SDK consumers.
const destination = new URL('../src/profileColors.generated.ts', import.meta.url);
const entries = COLOR_PRESET_REGISTRY.map(({ name, gate }) => ({ name, gate: gate ?? null }));
const output = `// Generated from published @oxy.so/bloom/color-presets. Do not edit.\n// Regenerate: bun run generate:profile-colors\nexport const USER_PROFILE_COLORS = ${JSON.stringify(entries, null, 2)} as const;\n\nexport const USER_PROFILE_COLOR_PRESETS = USER_PROFILE_COLORS.map(({ name }) => name);\nexport const FREE_USER_PROFILE_COLOR_PRESETS = USER_PROFILE_COLORS.filter(({ gate }) => gate === null).map(({ name }) => name);\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== output) {
    throw new Error('Profile colors differ from Bloom. Run generate:profile-colors and regenerate the users constraint migration.');
  }
} else {
  writeFileSync(destination, output);
}
