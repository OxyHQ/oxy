/**
 * Jest global teardown — Postgres.
 *
 * Drops every throwaway database `jest.globalSetup.ts` created. Global setup and
 * teardown share a process, so the manifest path and `DATABASE_URL` still hold
 * the values setup published; `dropTestDatabase` refuses any name that is not
 * one of its own, so a stray value here cannot destroy a real database.
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { dropTestDatabase } from './src/db/testDatabase';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { OXY_JEST_DATABASE_MANIFEST } = require('./jest.workerCount.cjs');

export default async function globalTeardown(): Promise<void> {
  const manifestPath = process.env[OXY_JEST_DATABASE_MANIFEST];
  if (manifestPath) {
    const urls = JSON.parse(readFileSync(manifestPath, 'utf8')) as string[];
    for (const url of urls) {
      await dropTestDatabase(url);
    }
    try {
      unlinkSync(manifestPath);
    } catch {
      // Best-effort — a leftover manifest is harmless.
    }
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) return;
  await dropTestDatabase(url);
}
