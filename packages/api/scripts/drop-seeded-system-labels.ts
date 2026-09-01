#!/usr/bin/env bun
/**
 * One-time migration: delete the per-user copies of the system labels.
 *
 * Why it exists:
 *   The eight built-in labels (Personal, Work, Finance, …) used to be seeded
 *   into `labels` for every user by `ensureDefaultLabels`. They are constants
 *   now (`src/constants/systemLabels.ts`) and `listLabels` returns them
 *   directly, so the seeded rows are dead weight: identical for every account,
 *   never edited, and now shadowed by their constant.
 *
 * Behavior:
 *   - Deletes `labels` rows whose name matches a system label, case-insensitively.
 *   - Leaves `Message.labels` untouched: messages reference labels BY NAME, and
 *     the names are unchanged, so every existing assignment keeps working.
 *   - Leaves user-created labels alone, including one that merely shares a
 *     colour or order with a system label.
 *   - Idempotent — safe to re-run; a second run deletes nothing.
 *
 * Run:
 *   cd packages/api && bun run scripts/drop-seeded-system-labels.ts
 *
 * Optional env:
 *   MONGODB_URI    Mongo connection string (required)
 *   DRY_RUN=true   Report what would be deleted without writing
 */

import mongoose from 'mongoose';
import { Label } from '../src/models/Label';
import { SYSTEM_LABELS } from '../src/constants/systemLabels';

const DRY_RUN = process.env.DRY_RUN === 'true';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(uri);

  // Exact names, matched case-insensitively via a collation so the query uses
  // the same comparison the service does.
  const names = SYSTEM_LABELS.map((l) => l.name);
  const filter = { name: { $in: names } };

  const matched = await Label.countDocuments(filter).collation({ locale: 'en', strength: 2 });
  const owners = (await Label.distinct('userId', filter)).length;

  if (DRY_RUN) {
    console.log(`[dry-run] would delete ${matched} seeded label rows across ${owners} users`);
  } else {
    const { deletedCount } = await Label.deleteMany(filter).collation({ locale: 'en', strength: 2 });
    console.log(`deleted ${deletedCount} seeded label rows across ${owners} users`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
