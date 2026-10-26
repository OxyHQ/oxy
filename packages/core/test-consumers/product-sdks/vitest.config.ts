import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Product transports are deliberately the installed packages. No source aliases.
  },
});
