/**
 * Resolve Bloom's Oxy preset for self-contained email HTML. The API consumes
 * this small snapshot so it never loads Bloom's React Native runtime.
 * Run from the repo root: bun scripts/generate-email-theme.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tokens = require('@oxy.so/bloom/design-tokens/tokens.json');
const roles = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'muted-foreground',
  'primary',
  'primary-foreground',
  'border',
];
const palette = (scheme) =>
  Object.fromEntries(roles.map((role) => [role, tokens.color.oxy[scheme][role].$value]));
const typography = Object.fromEntries(
  ['body', 'bodySmall', 'sectionTitle', 'headerBold', 'buttonLarge'].map((role) => [
    role,
    Object.fromEntries(
      Object.entries(tokens.typography[role]).map(([key, token]) => [key, token.$value]),
    ),
  ]),
);
const output = `${JSON.stringify(
  {
    source: '@oxy.so/bloom/design-tokens/tokens.json — oxy preset; generated, do not edit',
    light: palette('light'),
    dark: palette('dark'),
    radius: {
      card: tokens.radius['radius-16'].$value,
      button: tokens.radius['radius-max'].$value,
    },
    typography,
  },
  null,
  2,
)}\n`;
const destination = new URL(
  '../packages/api/src/services/emailTheme.generated.json',
  import.meta.url,
);
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== output) {
    throw new Error('Email theme is stale. Run bun scripts/generate-email-theme.mjs');
  }
} else {
  writeFileSync(destination, output);
}
