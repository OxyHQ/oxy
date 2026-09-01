#!/usr/bin/env bun
/**
 * Idempotent seed: give the app store its opening shelves.
 *
 * The store's API is complete and `app_categories` is empty, which means a
 * publisher opening the Console's Store tab finds an empty category select and
 * nothing to file their page under. This puts the first shelves in.
 *
 * ## Insert-only, on purpose
 *
 * `app_categories` is a table rather than a CHECK-constrained column precisely
 * so the vocabulary belongs to whoever curates the store rather than to a
 * migration (see `db/schema/appCategories.ts`). So this script ADDS shelves it
 * does not find and never touches one that already exists: a curator who
 * renames "Housing" to "Homes" through `PATCH /store/moderation/categories`
 * must not have it renamed back the next time somebody runs a seed.
 *
 * Re-running therefore reports zero inserts once seeded, which is also the
 * check that it is idempotent.
 *
 * ## Why these shelves
 *
 * Every one of them has a real Oxy app that could sit on it today —
 * `scripts/seed-oxy-applications.ts` is the list. Shelves for a catalogue that
 * does not exist yet (Games, Health, Education) are left out: an empty shelf on
 * a storefront reads as a store that is missing things, and adding one later is
 * a single POST.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/scripts/seed-store-categories.ts
 *
 * Env:
 *   DATABASE_URL   required (injected by ECS from SSM)
 *   DRY_RUN=1|true plan only, no writes
 */

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { appCategories } from '../src/db/schema/appCategories';
import { logger } from '../src/utils/logger';

interface SeedCategory {
  slug: string;
  label: string;
  description: string;
  /** Running order. Spaced by ten so a shelf can be slotted between two. */
  order: number;
}

const SHELVES: SeedCategory[] = [
  {
    slug: 'social',
    label: 'Social',
    description: 'Places to post, follow and talk in the open.',
    order: 10,
  },
  {
    slug: 'messaging',
    label: 'Messaging',
    description: 'Private conversation, one to one and in groups.',
    order: 20,
  },
  {
    slug: 'productivity',
    label: 'Productivity',
    description: 'Mail, notes, calendars and the rest of the working day.',
    order: 30,
  },
  {
    slug: 'finance',
    label: 'Finance',
    description: 'Money: holding it, sending it and keeping track of it.',
    order: 40,
  },
  {
    slug: 'shopping',
    label: 'Shopping',
    description: 'Marketplaces and storefronts.',
    order: 50,
  },
  {
    slug: 'housing',
    label: 'Housing',
    description: 'Finding somewhere to live, and letting somewhere out.',
    order: 60,
  },
  {
    slug: 'developer-tools',
    label: 'Developer tools',
    description: 'Things you build with, and things you run.',
    order: 70,
  },
  {
    slug: 'ai',
    label: 'AI',
    description: 'Assistants, agents and the models behind them.',
    order: 80,
  },
  {
    slug: 'utilities',
    label: 'Utilities',
    description: 'Small things that do one job well.',
    order: 90,
  },
];

function isDryRun(): boolean {
  const value = process.env.DRY_RUN;
  return value === '1' || value === 'true';
}

async function seed(): Promise<void> {
  const dryRun = isDryRun();
  await connectPostgres();

  const slugs = SHELVES.map((shelf) => shelf.slug);
  const existing = await getDb()
    .select({ slug: appCategories.slug })
    .from(appCategories)
    .where(inArray(appCategories.slug, slugs));

  const present = new Set(existing.map((row) => row.slug));
  const missing = SHELVES.filter((shelf) => !present.has(shelf.slug));

  logger.info('Store categories seed plan', {
    dryRun,
    total: SHELVES.length,
    alreadyPresent: present.size,
    toInsert: missing.map((shelf) => shelf.slug),
  });

  if (missing.length === 0) {
    logger.info('Every shelf is already there. Nothing to do.');
    await closePostgres();
    return;
  }

  if (dryRun) {
    logger.info('DRY_RUN — no writes performed');
    await closePostgres();
    return;
  }

  // `onConflictDoNothing` as well as the read above: the read is what makes the
  // log honest, and this is what makes a concurrent run safe.
  const inserted = await getDb()
    .insert(appCategories)
    .values(
      missing.map((shelf) => ({
        slug: shelf.slug,
        label: shelf.label,
        description: shelf.description,
        order: shelf.order,
      }))
    )
    .onConflictDoNothing({ target: appCategories.slug })
    .returning({ slug: appCategories.slug });

  logger.info('Store categories seeded', {
    inserted: inserted.map((row) => row.slug),
    insertedCount: inserted.length,
  });

  await closePostgres();
}

seed().catch(async (error: unknown) => {
  logger.error(
    'Store categories seed failed',
    error instanceof Error ? error : new Error(String(error))
  );
  await closePostgres().catch(() => undefined);
  process.exit(1);
});
