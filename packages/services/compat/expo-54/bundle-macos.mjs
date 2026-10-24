import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Metro = require('metro');

mkdirSync('dist-macos', { recursive: true });
const config = await Metro.loadConfig({ config: './metro.config.js' });
await Metro.runBuild(config, {
  entry: './index.tsx',
  platform: 'macos',
  dev: true,
  minify: false,
  out: 'dist-macos/index.macos.js',
});
